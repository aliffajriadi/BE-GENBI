import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma, type Prisma } from "../../lib/prisma.js";
import { createDivisionSchema, createPeriodSchema, createUserSchema, updateDivisionSchema, updateUserSchema, type RoleKey } from "../../shared/index.js";
import { z } from "zod";
import { auth, requirePermission } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import { cache } from "../../lib/cache.js";
import { AppError } from "../../utils/app-error.js";
import { paging } from "../../utils/paging.js";
import { ok } from "../../utils/response.js";
import { audit } from "../audit/audit.service.js";
import { channelsChanged } from "../chat/chat.service.js";

export const usersRoutes = Router();

const publicUser = { passwordHash: true } as const;

// ───── Anggota ─────

usersRoutes.get("/users", auth, requirePermission("user.read"), async (req, res) => {
  const u = req.user!;
  const { skip, take, page } = paging(req.query);
  const membership: Prisma.MembershipWhereInput = { periodId: u.periodId };
  // Kadiv hanya melihat anggota divisinya.
  if (u.role === "KADIV") membership.divisionId = u.divisionId ?? "__none__";
  else if (req.query.divisionId) membership.divisionId = String(req.query.divisionId);
  if (req.query.role) membership.role = { key: String(req.query.role) };
  if (req.query.status) membership.user = { status: String(req.query.status) as "ACTIVE" | "INACTIVE" | "ALUMNI" };
  const where: Prisma.UserWhereInput = { deletedAt: null, memberships: { some: membership } };
  if (req.query.q) where.OR = [{ name: { contains: String(req.query.q) } }, { email: { contains: String(req.query.q) } }, { nim: { contains: String(req.query.q) } }];

  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take,
      orderBy: { name: "asc" },
      omit: publicUser,
      include: { memberships: { where: { periodId: u.periodId }, include: { role: true, division: true } } },
    }),
    prisma.user.count({ where }),
  ]);
  ok(
    res,
    rows.map(({ memberships, ...user }) => ({
      ...user,
      role: memberships[0]?.role.key,
      roleName: memberships[0]?.role.name,
      position: memberships[0]?.position,
      division: memberships[0]?.division ? { id: memberships[0].division.id, name: memberships[0].division.name } : null,
    })),
    { page, total },
  );
});

usersRoutes.post("/users", auth, requirePermission("user.manage"), validate(createUserSchema), async (req, res) => {
  const { password, roleKey, divisionId, position, ...data } = req.body as z.infer<typeof createUserSchema>;
  if (roleKey === "SYS_ADMIN" && req.user!.role !== "SYS_ADMIN") throw new AppError("FORBIDDEN", 403, "Hanya admin yang bisa membuat admin");
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: { ...data, email: data.email.toLowerCase(), passwordHash: await bcrypt.hash(password, 10) },
      omit: publicUser,
    });
    await tx.membership.create({ data: { userId: created.id, periodId: req.user!.periodId, roleId: role.id, divisionId: divisionId ?? null, position } });
    await audit(req, "user.create", "User", created.id, null, { ...created, roleKey, divisionId }, tx);
    return created;
  });
  ok(res, user, undefined, 201);
});

usersRoutes.get("/users/:id", auth, async (req, res) => {
  const id = String(req.params.id);
  const u = req.user!;
  if (id !== u.id && !u.permissions.has("user.read")) throw new AppError("FORBIDDEN", 403, "Tidak punya akses");
  const user = await prisma.user.findFirst({
    where: { id, deletedAt: null },
    omit: publicUser,
    include: { memberships: { include: { role: true, division: true, period: true }, orderBy: { createdAt: "desc" } } },
  });
  if (!user) throw new AppError("NOT_FOUND", 404, "Anggota tidak ditemukan");
  if (u.role === "KADIV" && id !== u.id && !user.memberships.some((m) => m.periodId === u.periodId && m.divisionId === u.divisionId)) {
    throw new AppError("FORBIDDEN", 403, "Bukan anggota divisi Anda");
  }
  const [sum, points, attendance] = await Promise.all([
    prisma.pointLedger.aggregate({ where: { userId: id, periodId: u.periodId }, _sum: { points: true } }),
    prisma.pointLedger.findMany({ where: { userId: id, periodId: u.periodId }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.attendance.findMany({
      where: { userId: id, event: { deletedAt: null } },
      orderBy: { scannedAt: "desc" },
      take: 50,
      include: { event: { select: { id: true, title: true, type: true, startAt: true } } },
    }),
  ]);
  ok(res, { ...user, points: { total: sum._sum.points ?? 0, history: points }, attendance });
});

usersRoutes.patch("/users/:id", auth, requirePermission("user.manage"), validate(updateUserSchema), async (req, res) => {
  const id = String(req.params.id);
  const { roleKey, divisionId, position, resetDevice, ...data } = req.body as z.infer<typeof updateUserSchema>;
  if (roleKey === "SYS_ADMIN" && req.user!.role !== "SYS_ADMIN") throw new AppError("FORBIDDEN", 403, "Hanya admin yang bisa memberi role admin");
  const before = await prisma.user.findUniqueOrThrow({ where: { id }, omit: publicUser, include: { memberships: { where: { periodId: req.user!.periodId } } } });

  const user = await prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id },
      data: { ...data, ...(data.email ? { email: data.email.toLowerCase() } : {}), ...(resetDevice ? { deviceId: null } : {}) },
      omit: publicUser,
    });
    if (roleKey || divisionId !== undefined || position !== undefined) {
      const role = roleKey ? await tx.role.findUniqueOrThrow({ where: { key: roleKey } }) : null;
      const m = before.memberships[0];
      if (m) {
        await tx.membership.update({ where: { id: m.id }, data: { ...(role ? { roleId: role.id } : {}), ...(divisionId !== undefined ? { divisionId } : {}), ...(position !== undefined ? { position } : {}) } });
      } else if (role) {
        await tx.membership.create({ data: { userId: id, periodId: req.user!.periodId, roleId: role.id, divisionId: divisionId ?? null, position } });
      } else {
        throw new AppError("VALIDATION", 400, "Anggota belum punya jabatan periode ini; isi roleKey");
      }
    }
    // Perubahan role/status: cabut sesi supaya token lama tidak dipakai.
    if (roleKey || data.status) await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(req, roleKey ? "user.role_change" : resetDevice ? "user.reset_device" : "user.update", "User", id, before, { ...updated, roleKey, divisionId, position }, tx);
    return updated;
  });
  ok(res, user);
});

usersRoutes.delete("/users/:id", auth, requirePermission("user.manage"), async (req, res) => {
  const id = String(req.params.id);
  if (id === req.user!.id) throw new AppError("VALIDATION", 400, "Tidak bisa menghapus akun sendiri");
  await prisma.$transaction([
    prisma.user.update({ where: { id }, data: { deletedAt: new Date(), status: "INACTIVE" } }),
    prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  await audit(req, "user.delete", "User", id);
  ok(res, null);
});

// ───── Role & permission ─────

usersRoutes.get("/roles", auth, requirePermission("user.read", "role.manage"), async (_req, res) => {
  const roles = await prisma.role.findMany({ include: { permissions: { include: { permission: true } } } });
  ok(res, roles.map((r) => ({ id: r.id, key: r.key, name: r.name, permissions: r.permissions.map((p) => p.permission.key) })));
});

usersRoutes.get("/permissions", auth, requirePermission("role.manage"), async (_req, res) => {
  ok(res, await prisma.permission.findMany({ orderBy: { key: "asc" } }));
});

usersRoutes.patch("/roles/:id/permissions", auth, requirePermission("role.manage"), validate(z.object({ permissions: z.array(z.string()) })), async (req, res) => {
  const role = await prisma.role.findUniqueOrThrow({ where: { id: String(req.params.id) }, include: { permissions: { include: { permission: true } } } });
  if (role.key === "SYS_ADMIN") throw new AppError("VALIDATION", 400, "Permission System Administrator tidak bisa diubah");
  const perms = await prisma.permission.findMany({ where: { key: { in: req.body.permissions } } });
  await prisma.$transaction(async (tx) => {
    await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
    await tx.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
    await audit(req, "role.permissions", "Role", role.id, role.permissions.map((p) => p.permission.key), perms.map((p) => p.key), tx);
  });
  cache.del(`perms:${role.key as RoleKey}`);
  ok(res, { id: role.id, permissions: perms.map((p) => p.key) });
});

// ───── Divisi & periode ─────

usersRoutes.get("/divisions", auth, async (req, res) => {
  ok(
    res,
    await prisma.division.findMany({
      where: { periodId: String(req.query.periodId ?? req.user!.periodId) },
      orderBy: { name: "asc" },
      include: { _count: { select: { memberships: true } } },
    }),
  );
});

usersRoutes.post("/divisions", auth, requirePermission("division.manage"), validate(createDivisionSchema), async (req, res) => {
  const d = await prisma.division.create({ data: { ...req.body, periodId: req.user!.periodId } });
  await audit(req, "division.create", "Division", d.id, null, d);
  channelsChanged();
  ok(res, d, undefined, 201);
});

usersRoutes.patch("/divisions/:id", auth, requirePermission("division.manage"), validate(updateDivisionSchema), async (req, res) => {
  const before = await prisma.division.findUniqueOrThrow({ where: { id: String(req.params.id) } });
  const d = await prisma.division.update({ where: { id: before.id }, data: req.body });
  await audit(req, "division.update", "Division", d.id, before, d);
  ok(res, d);
});

usersRoutes.get("/periods", auth, async (_req, res) => {
  ok(res, await prisma.period.findMany({ orderBy: { startDate: "desc" } }));
});

usersRoutes.post("/periods", auth, requirePermission("division.manage"), validate(createPeriodSchema), async (req, res) => {
  const p = await prisma.period.create({ data: req.body });
  await audit(req, "period.create", "Period", p.id, null, p);
  ok(res, p, undefined, 201);
});

usersRoutes.post("/periods/:id/activate", auth, requirePermission("division.manage"), async (req, res) => {
  const id = String(req.params.id);
  // Pastikan admin yang mengaktifkan tetap punya jabatan di periode baru, supaya tidak terkunci.
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { key: req.user!.role } });
  await prisma.$transaction([
    prisma.period.updateMany({ data: { isActive: false } }),
    prisma.period.update({ where: { id }, data: { isActive: true } }),
    prisma.membership.upsert({
      where: { userId_periodId: { userId: req.user!.id, periodId: id } },
      update: {},
      create: { userId: req.user!.id, periodId: id, roleId: adminRole.id },
    }),
  ]);
  await audit(req, "period.activate", "Period", id);
  channelsChanged();
  ok(res, { id, isActive: true });
});
