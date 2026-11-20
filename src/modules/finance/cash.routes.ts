import { Router } from "express";
import ExcelJS from "exceljs";
import { prisma, type Prisma } from "../../lib/prisma.js";
import { auth } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import {
    cashTransactionSchema
} from "../../shared/index.js";
import { AppError } from "../../utils/app-error.js";
import { paging } from "../../utils/paging.js";
import { ok } from "../../utils/response.js";
import { audit } from "../audit/audit.service.js";
import { BILL_LABEL } from "./billing.js";
import { assertTreasury } from "./treasury.js";
import { id, kasOf, ownUpload } from "./helpers.js";

export const cashRoutes = Router();

// ───── Buku kas ─────

cashRoutes.get("/cash-transactions", auth, async (req, res) => {
  const t = kasOf(req.query);
  assertTreasury(req.user!, t, "read");
  const { skip, take, page } = paging(req.query);
  const where: Prisma.CashTransactionWhereInput = { deletedAt: null, treasuryDivisionId: t };
  if (req.query.type) where.type = String(req.query.type) as "IN" | "OUT";
  if (req.query.from || req.query.to) where.date = { ...(req.query.from ? { gte: new Date(String(req.query.from)) } : {}), ...(req.query.to ? { lt: new Date(String(req.query.to)) } : {}) };
  const [rows, total] = await Promise.all([prisma.cashTransaction.findMany({ where, skip, take, orderBy: [{ date: "desc" }, { createdAt: "desc" }] }), prisma.cashTransaction.count({ where })]);
  ok(res, rows, { page, total });
});

cashRoutes.post("/cash-transactions", auth, validate(cashTransactionSchema), async (req, res) => {
  const kas = kasOf(req.query);
  assertTreasury(req.user!, kas, "manage");
  const { attachmentId, ...data } = req.body;
  const t = await prisma.cashTransaction.create({ data: { ...data, treasuryDivisionId: kas, attachmentUrl: attachmentId ? await ownUpload(attachmentId, req.user!.id) : undefined } });
  await audit(req, "cash.create", "CashTransaction", t.id, null, t);
  ok(res, t, undefined, 201);
});

cashRoutes.delete("/cash-transactions/:id", auth, async (req, res) => {
  const t = await prisma.cashTransaction.findUniqueOrThrow({ where: { id: id(req.params.id) } });
  assertTreasury(req.user!, t.treasuryDivisionId, "manage");
  if (t.refType === "Payment") throw new AppError("VALIDATION", 400, "Transaksi dari pembayaran kas tidak bisa dihapus");
  await prisma.cashTransaction.update({ where: { id: t.id }, data: { deletedAt: new Date() } });
  await audit(req, "cash.delete", "CashTransaction", t.id, t, null);
  ok(res, null);
});

cashRoutes.get("/finance/summary", auth, async (req, res) => {
  const t = kasOf(req.query);
  assertTreasury(req.user!, t, "read");
  const cashT = { deletedAt: null, treasuryDivisionId: t };
  const billT = { plan: { treasuryDivisionId: t } };
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const sixAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const [sums, month, pending, overdue, unpaid, recent] = await Promise.all([
    prisma.cashTransaction.groupBy({ by: ["type"], where: cashT, _sum: { amount: true } }),
    prisma.cashTransaction.groupBy({ by: ["type"], where: { ...cashT, date: { gte: monthStart } }, _sum: { amount: true } }),
    prisma.payment.count({ where: { status: "PENDING", treasuryDivisionId: t } }),
    prisma.duesBill.aggregate({ where: { ...billT, status: "OVERDUE" }, _count: true, _sum: { amount: true } }),
    prisma.duesBill.aggregate({ where: { ...billT, status: { in: ["UNPAID", "REJECTED", "OVERDUE"] } }, _sum: { amount: true } }),
    prisma.cashTransaction.findMany({ where: { ...cashT, date: { gte: sixAgo } }, select: { type: true, amount: true, date: true } }),
  ]);
  const sum = (rows: typeof sums, t: "IN" | "OUT") => rows.find((r) => r.type === t)?._sum.amount ?? 0;
  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1);
    const inMonth = (x: { date: Date }) => x.date.getFullYear() === d.getFullYear() && x.date.getMonth() === d.getMonth();
    return {
      month: d.toLocaleDateString("id-ID", { month: "short" }),
      in: recent.filter((x) => x.type === "IN" && inMonth(x)).reduce((s, x) => s + x.amount, 0),
      out: recent.filter((x) => x.type === "OUT" && inMonth(x)).reduce((s, x) => s + x.amount, 0),
    };
  });
  ok(res, {
    balance: sum(sums, "IN") - sum(sums, "OUT"),
    monthIn: sum(month, "IN"),
    monthOut: sum(month, "OUT"),
    pendingPayments: pending,
    overdue: { count: overdue._count, amount: overdue._sum.amount ?? 0 },
    outstanding: unpaid._sum.amount ?? 0,
    months,
  });
});

// Laporan Excel: buku kas + rekap tagihan per anggota.
cashRoutes.get("/finance/report/export", auth, async (req, res) => {
  const t = kasOf(req.query);
  assertTreasury(req.user!, t, "read");
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(new Date().getFullYear(), 0, 1);
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  const [cash, bills] = await Promise.all([
    prisma.cashTransaction.findMany({ where: { deletedAt: null, treasuryDivisionId: t, date: { gte: from, lte: to } }, orderBy: { date: "asc" } }),
    prisma.duesBill.findMany({ where: { plan: { treasuryDivisionId: t } }, include: { user: { select: { name: true } }, plan: { select: { name: true } } }, orderBy: [{ user: { name: "asc" } }, { dueDate: "asc" }] }),
  ]);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Buku kas");
  ws.columns = [
    { header: "Tanggal", key: "date", width: 14 },
    { header: "Jenis", key: "type", width: 10 },
    { header: "Kategori", key: "category", width: 20 },
    { header: "Keterangan", key: "description", width: 50 },
    { header: "Masuk", key: "in", width: 14 },
    { header: "Keluar", key: "out", width: 14 },
    { header: "Saldo", key: "balance", width: 14 },
  ];
  let bal = 0;
  for (const t of cash) {
    bal += t.type === "IN" ? t.amount : -t.amount;
    ws.addRow({ date: t.date, type: t.type === "IN" ? "Masuk" : "Keluar", category: t.category, description: t.description, in: t.type === "IN" ? t.amount : null, out: t.type === "OUT" ? t.amount : null, balance: bal });
  }
  const ws2 = wb.addWorksheet("Tagihan anggota");
  ws2.columns = [
    { header: "Anggota", key: "name", width: 28 },
    { header: "Iuran", key: "plan", width: 22 },
    { header: "Periode", key: "period", width: 18 },
    { header: "Nominal", key: "amount", width: 12 },
    { header: "Jatuh tempo", key: "due", width: 14 },
    { header: "Status", key: "status", width: 12 },
  ];
  const STATUS: Record<string, string> = { UNPAID: "Belum bayar", PENDING: "Menunggu", PAID: "Lunas", REJECTED: "Ditolak", OVERDUE: "Menunggak" };
  for (const b of bills) ws2.addRow({ name: b.user.name, plan: b.plan.name, period: BILL_LABEL(b.periodLabel), amount: b.amount, due: b.dueDate, status: STATUS[b.status] });
  for (const s of [ws, ws2]) s.getRow(1).font = { bold: true };
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="laporan-keuangan.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});
