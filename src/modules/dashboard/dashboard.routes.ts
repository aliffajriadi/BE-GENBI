import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { auth } from "../../middlewares/auth.js";
import { ok } from "../../utils/response.js";

export const dashboardRoutes = Router();

// Isi menyesuaikan permission (PRD bagian 10). Modul kas/artikel/administrasi menyusul.
dashboardRoutes.get("/dashboard", auth, async (req, res) => {
  const u = req.user!;
  const now = new Date();
  const mine = { OR: [{ scope: "ALL" as const }, { participants: { some: { userId: u.id } } }, ...(u.divisionId ? [{ scope: "DIVISION" as const, divisionId: u.divisionId }] : [])] };

  const [upcoming, myPoints, board, openEvents, pendingLeaves, activeUsers] = await Promise.all([
    prisma.event.findMany({ where: { deletedAt: null, endAt: { gte: now }, ...mine }, orderBy: { startAt: "asc" }, take: 5, omit: { qrSecret: true } }),
    prisma.pointLedger.aggregate({ where: { userId: u.id, periodId: u.periodId }, _sum: { points: true } }),
    prisma.pointLedger.groupBy({ by: ["userId"], where: { periodId: u.periodId }, _sum: { points: true }, orderBy: { _sum: { points: "desc" } } }),
    u.permissions.has("event.create")
      ? prisma.event.findMany({
          where: { deletedAt: null, attendanceStatus: "OPEN", ...(u.permissions.has("event.manage_all") ? {} : { OR: [{ createdById: u.id }, { divisionId: u.divisionId ?? "__none__" }] }) },
          select: { id: true, title: true },
        })
      : [],
    u.permissions.has("leave.decide")
      ? prisma.leaveRequest.count({
          where: { status: "PENDING", event: { deletedAt: null, ...(u.permissions.has("event.manage_all") ? {} : { OR: [{ createdById: u.id }, { divisionId: u.divisionId ?? "__none__" }] }) } },
        })
      : 0,
    u.permissions.has("settings.manage") ? prisma.user.count({ where: { status: "ACTIVE", deletedAt: null } }) : null,
  ]);

  const [bills, tasks, pendingPayments] = await Promise.all([
    prisma.duesBill.aggregate({ where: { userId: u.id, status: { in: ["UNPAID", "REJECTED", "OVERDUE"] } }, _count: true, _sum: { amount: true } }),
    prisma.actionItem.findMany({ where: { picId: u.id, done: false }, orderBy: { dueDate: "asc" }, take: 5, include: { minute: { select: { event: { select: { title: true } } } } } }),
    u.permissions.has("finance.manage") ? prisma.payment.count({ where: { status: "PENDING" } }) : null,
  ]);
  const rankIdx = board.findIndex((b) => b.userId === u.id);
  ok(res, {
    upcomingEvents: upcoming,
    points: { total: myPoints._sum.points ?? 0, rank: rankIdx >= 0 ? rankIdx + 1 : null, of: board.length },
    openEvents,
    pendingLeaves,
    activeUsers,
    bills: { count: bills._count, amount: bills._sum.amount ?? 0 },
    tasks,
    pendingPayments,
  });
});
