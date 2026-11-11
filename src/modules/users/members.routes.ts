import { Router } from "express";
import { prisma, type Prisma } from "../../lib/prisma.js";
import { auth } from "../../middlewares/auth.js";
import { AppError } from "../../utils/app-error.js";
import { paging } from "../../utils/paging.js";
import { ok } from "../../utils/response.js";

// Direktori & profil anggota untuk SEMUA anggota yang login.
// Hanya data yang pantas dilihat sesama anggota; email, HP, NIM tetap lewat /users (butuh user.read).
export const membersRoutes = Router();

const safeUser = { id: true, name: true, avatarUrl: true, coverUrl: true, bio: true, instagram: true, tiktok: true, website: true, campus: true, major: true, batch: true, status: true } as const;

membersRoutes.get("/members", auth, async (req, res) => {
  const { skip, take, page } = paging({ ...req.query, limit: req.query.limit ?? 48 });
  const membership: Prisma.MembershipWhereInput = { periodId: req.user!.periodId, role: { key: { not: "SYS_ADMIN" } } };
  if (req.query.divisionId) membership.divisionId = String(req.query.divisionId);
  const where: Prisma.UserWhereInput = { deletedAt: null, status: "ACTIVE", memberships: { some: membership } };
  if (req.query.q) where.name = { contains: String(req.query.q) };
  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where, skip, take, orderBy: { name: "asc" },
      select: { ...safeUser, memberships: { where: { periodId: req.user!.periodId }, select: { position: true, role: { select: { name: true } }, division: { select: { id: true, name: true } } } } },
    }),
    prisma.user.count({ where }),
  ]);
  ok(res, rows.map(({ memberships: [m], ...u }) => ({ ...u, position: m?.position ?? m?.role.name ?? null, division: m?.division ?? null })), { page, total });
});

membersRoutes.get("/members/:id", auth, async (req, res) => {
  const periodId = req.user!.periodId;
  const u = await prisma.user.findFirst({
    where: { id: String(req.params.id), deletedAt: null },
    select: {
      ...safeUser,
      createdAt: true,
      memberships: { orderBy: { createdAt: "desc" }, select: { position: true, periodId: true, role: { select: { name: true } }, division: { select: { name: true } }, period: { select: { name: true, isActive: true } } } },
    },
  });
  if (!u) throw new AppError("NOT_FOUND", 404, "Anggota tidak ditemukan");

  const [board, att, articles] = await Promise.all([
    prisma.pointLedger.groupBy({ by: ["userId"], where: { periodId }, _sum: { points: true }, orderBy: { _sum: { points: "desc" } } }),
    prisma.attendance.groupBy({ by: ["status"], where: { userId: u.id, event: { deletedAt: null, attendanceStatus: "DONE" } }, _count: true }),
    prisma.article.findMany({
      where: { authorId: u.id, status: "PUBLISHED", deletedAt: null },
      orderBy: { publishedAt: "desc" },
      take: 20,
      select: { id: true, title: true, slug: true, kind: true, excerpt: true, coverUrl: true, publishedAt: true },
    }),
  ]);
  const rankIdx = board.findIndex((b) => b.userId === u.id);
  const count = (s: string) => att.find((a) => a.status === s)?._count ?? 0;
  const totalAtt = att.reduce((s, a) => s + a._count, 0);
  const current = u.memberships.find((m) => m.periodId === periodId);

  ok(res, {
    ...u,
    position: current?.position ?? current?.role.name ?? null,
    division: current?.division?.name ?? null,
    stats: {
      points: rankIdx >= 0 ? board[rankIdx]._sum.points ?? 0 : 0,
      rank: rankIdx >= 0 ? rankIdx + 1 : null,
      of: board.length,
      attendance: totalAtt ? Math.round(((count("HADIR") + count("TELAT")) / totalAtt) * 100) : null,
      events: totalAtt,
      articles: articles.length,
    },
    articles,
  });
});
