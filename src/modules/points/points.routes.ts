import { Router } from "express";
import { prisma, type Prisma } from "../../lib/prisma.js";
import { adjustPointsSchema, pointRuleSchema, GLOBAL_ROLES } from "../../shared/index.js";
import { auth, requirePermission } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import { AppError } from "../../utils/app-error.js";
import { ok } from "../../utils/response.js";
import { audit } from "../audit/audit.service.js";
import { invalidateRules } from "./points.service.js";

export const pointsRoutes = Router();

pointsRoutes.get("/points/me", auth, async (req, res) => {
  const where = { userId: req.user!.id, periodId: String(req.query.periodId ?? req.user!.periodId) };
  const [history, sum] = await Promise.all([
    prisma.pointLedger.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.pointLedger.aggregate({ where, _sum: { points: true } }),
  ]);
  ok(res, { total: sum._sum.points ?? 0, history });
});

// ?periodId=&divisionId=&from=&to= (bulan/semester = rentang tanggal)
pointsRoutes.get("/points/leaderboard", auth, async (req, res) => {
  const q = req.query;
  const periodId = String(q.periodId ?? req.user!.periodId);
  const where: Prisma.PointLedgerWhereInput = { periodId };
  if (q.from || q.to) where.createdAt = { ...(q.from ? { gte: new Date(String(q.from)) } : {}), ...(q.to ? { lt: new Date(String(q.to)) } : {}) };
  if (q.divisionId) where.user = { memberships: { some: { periodId, divisionId: String(q.divisionId) } } };

  const groups = await prisma.pointLedger.groupBy({ by: ["userId"], where, _sum: { points: true }, orderBy: { _sum: { points: "desc" } } });
  const users = await prisma.user.findMany({
    where: { id: { in: groups.map((g) => g.userId) } },
    select: { id: true, name: true, avatarUrl: true, memberships: { where: { periodId }, select: { division: { select: { name: true } } } } },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  ok(
    res,
    groups.map((g, i) => {
      const u = byId.get(g.userId);
      return { rank: i + 1, userId: g.userId, name: u?.name, avatarUrl: u?.avatarUrl, division: u?.memberships[0]?.division?.name ?? null, points: g._sum.points ?? 0 };
    }),
  );
});

pointsRoutes.get("/points/users/:userId", auth, requirePermission("points.read_all", "points.adjust"), async (req, res) => {
  ok(res, await prisma.pointLedger.findMany({ where: { userId: req.params.userId as string, periodId: req.user!.periodId }, orderBy: { createdAt: "desc" } }));
});

pointsRoutes.post("/points/adjust", auth, requirePermission("points.adjust"), validate(adjustPointsSchema), async (req, res) => {
  const u = req.user!;
  const target = await prisma.membership.findFirst({ where: { userId: req.body.userId, periodId: u.periodId } });
  if (!target) throw new AppError("NOT_FOUND", 404, "Anggota tidak ada di periode aktif");
  // Kadiv hanya boleh memberi poin ke anggota divisinya.
  if (!GLOBAL_ROLES.includes(u.role) && (!u.divisionId || target.divisionId !== u.divisionId)) throw new AppError("FORBIDDEN", 403, "Hanya untuk anggota divisi Anda");

  const row = await prisma.$transaction(async (tx) => {
    const r = await tx.pointLedger.create({
      data: { userId: req.body.userId, periodId: u.periodId, points: req.body.points, sourceType: "MANUAL", sourceId: req.body.ruleKey, note: req.body.note, createdById: u.id },
    });
    await audit(req, "points.adjust", "PointLedger", r.id, null, r, tx);
    return r;
  });
  ok(res, row, undefined, 201);
});

pointsRoutes.get("/point-rules", auth, async (_req, res) => {
  ok(res, await prisma.pointRule.findMany({ orderBy: { createdAt: "asc" } }));
});

pointsRoutes.post("/point-rules", auth, requirePermission("points.rules"), validate(pointRuleSchema), async (req, res) => {
  const rule = await prisma.pointRule.create({ data: { ...req.body, updatedById: req.user!.id } });
  await audit(req, "pointRule.create", "PointRule", rule.id, null, rule);
  invalidateRules();
  ok(res, rule, undefined, 201);
});

// Perubahan nilai hanya berlaku ke kejadian berikutnya; ledger lama tidak diubah.
pointsRoutes.patch("/point-rules/:id", auth, requirePermission("points.rules"), validate(pointRuleSchema.partial().omit({ key: true })), async (req, res) => {
  const before = await prisma.pointRule.findUniqueOrThrow({ where: { id: req.params.id as string } });
  const rule = await prisma.pointRule.update({ where: { id: before.id }, data: { ...req.body, updatedById: req.user!.id } });
  await audit(req, "pointRule.update", "PointRule", rule.id, before, rule);
  invalidateRules();
  ok(res, rule);
});

pointsRoutes.delete("/point-rules/:id", auth, requirePermission("points.rules"), async (req, res) => {
  const before = await prisma.pointRule.findUniqueOrThrow({ where: { id: req.params.id as string } });
  const rule = await prisma.pointRule.update({ where: { id: before.id }, data: { isActive: false, updatedById: req.user!.id } });
  await audit(req, "pointRule.deactivate", "PointRule", rule.id, before, rule);
  invalidateRules();
  ok(res, rule);
});
