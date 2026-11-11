import { Router } from "express";
import { cache } from "../../lib/cache.js";
import { prisma } from "../../lib/prisma.js";
import { auth, grantsKey, type AuthUser } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import { DIVISION_AREAS, divisionAccessSchema, type DivisionArea } from "../../shared/index.js";
import { AppError } from "../../utils/app-error.js";
import { ok } from "../../utils/response.js";
import { audit } from "../audit/audit.service.js";
import { notify } from "../notifications/notifications.service.js";

// Kelola divisi: Kadiv mendelegasikan sebagian wewenangnya ke anggota divisinya sendiri.
// Sekretaris/admin (user.manage) boleh mengatur divisi mana pun.
export const divisionAccessRoutes = Router();

function assertManager(u: AuthUser, divisionId: string) {
  if (u.permissions.has("user.manage")) return;
  if (u.role === "KADIV" && u.divisionId === divisionId) return;
  throw new AppError("FORBIDDEN", 403, "Hanya kepala divisi ini yang bisa mengatur aksesnya");
}

divisionAccessRoutes.get("/divisions/:id/access", auth, async (req, res) => {
  const divisionId = String(req.params.id);
  assertManager(req.user!, divisionId);
  const division = await prisma.division.findFirst({ where: { id: divisionId, period: { isActive: true } }, select: { id: true, name: true } });
  if (!division) throw new AppError("NOT_FOUND", 404, "Divisi tidak ditemukan di periode aktif");
  const [members, grants] = await Promise.all([
    prisma.membership.findMany({
      where: { divisionId, period: { isActive: true }, user: { status: "ACTIVE", deletedAt: null } },
      select: { position: true, role: { select: { key: true, name: true } }, user: { select: { id: true, name: true, avatarUrl: true } } },
      orderBy: { user: { name: "asc" } },
    }),
    prisma.divisionGrant.findMany({ where: { divisionId }, select: { userId: true, area: true } }),
  ]);
  ok(res, {
    division,
    areas: Object.entries(DIVISION_AREAS).map(([key, a]) => ({ key, label: a.label, desc: a.desc })),
    members: members.map((m) => ({
      ...m.user,
      position: m.position ?? m.role.name,
      isHead: m.role.key === "KADIV", // kepala divisi sudah punya semua akses divisi
      areas: grants.filter((g) => g.userId === m.user.id).map((g) => g.area),
    })),
  });
});

divisionAccessRoutes.put("/divisions/:id/access/:userId", auth, validate(divisionAccessSchema), async (req, res) => {
  const divisionId = String(req.params.id);
  const userId = String(req.params.userId);
  assertManager(req.user!, divisionId);
  const m = await prisma.membership.findFirst({
    where: { userId, divisionId, period: { isActive: true }, user: { status: "ACTIVE", deletedAt: null } },
    include: { role: true },
  });
  if (!m) throw new AppError("VALIDATION", 400, "Orang ini bukan anggota aktif divisi ini");
  if (m.role.key === "KADIV") throw new AppError("VALIDATION", 400, "Kepala divisi sudah punya semua akses divisi");

  const areas = [...new Set(req.body.areas as DivisionArea[])];
  const before = (await prisma.divisionGrant.findMany({ where: { divisionId, userId }, select: { area: true } })).map((g) => g.area);
  await prisma.$transaction([
    prisma.divisionGrant.deleteMany({ where: { divisionId, userId, area: { notIn: areas } } }),
    prisma.divisionGrant.createMany({ data: areas.map((area) => ({ divisionId, userId, area, grantedById: req.user!.id })), skipDuplicates: true }),
  ]);
  cache.del(grantsKey(userId, divisionId)); // berlaku di request berikutnya, tanpa perlu login ulang
  await audit(req, "division.access", "DivisionGrant", userId, before, areas);
  const added = areas.filter((a) => !before.includes(a));
  if (added.length) await notify([userId], { type: "DIVISION_ACCESS", title: "Kamu diberi akses divisi", body: added.map((a) => DIVISION_AREAS[a].label).join(", ") });
  ok(res, { userId, areas });
});
