import { Router } from "express";
import ExcelJS from "exceljs";
import { prisma, type Prisma } from "../../lib/prisma.js";
import { auth } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import {
  bankAccountSchema,
  cashTransactionSchema,
  duesPlanSchema,
  paymentSchema,
  rejectSchema,
  updateDuesPlanSchema,
} from "../../shared/index.js";
import { AppError } from "../../utils/app-error.js";
import { paging } from "../../utils/paging.js";
import { ok } from "../../utils/response.js";
import { audit } from "../audit/audit.service.js";
import { notify } from "../notifications/notifications.service.js";
import { award } from "../points/points.service.js";
import { BILL_LABEL } from "./billing.js";
import { generateBills } from "./finance.service.js";
import { assertTreasury, canManageTreasury, canReadTreasury, treasuryManagers, treasuryOf, type Treasury } from "./treasury.js";

export const financeRoutes = Router();
const id = (v: unknown) => String(v);
const rupiah = (n: number) => `Rp${n.toLocaleString("id-ID")}`;
const kasOf = (q: { kas?: unknown }) => treasuryOf(q.kas);
const kasLink = (t: Treasury, tab: string) => `/dashboard/finance?tab=${tab}${t ? `&kas=${t}` : ""}`;

// Upload harus milik user sendiri; mengembalikan URL privat untuk disimpan.
async function ownUpload(uploadId: string, userId: string) {
  const u = await prisma.upload.findUnique({ where: { id: uploadId } });
  if (!u || u.ownerId !== userId) throw new AppError("VALIDATION", 400, "File bukti tidak valid");
  return `/files/${u.id}`;
}

// ───── Rekening tujuan ─────

financeRoutes.get("/bank-accounts", auth, async (req, res) => {
  const t = kasOf(req.query);
  const all = canManageTreasury(req.user!, t);
  ok(res, await prisma.bankAccount.findMany({ where: { treasuryDivisionId: t, ...(all ? {} : { isActive: true }) }, orderBy: { createdAt: "asc" } }));
});

financeRoutes.post("/bank-accounts", auth, validate(bankAccountSchema), async (req, res) => {
  const t = kasOf(req.query);
  assertTreasury(req.user!, t, "manage");
  const b = await prisma.bankAccount.create({ data: { ...req.body, treasuryDivisionId: t } });
  await audit(req, "bank.create", "BankAccount", b.id, null, b);
  ok(res, b, undefined, 201);
});

financeRoutes.patch("/bank-accounts/:id", auth, validate(bankAccountSchema.partial()), async (req, res) => {
  const before = await prisma.bankAccount.findUniqueOrThrow({ where: { id: id(req.params.id) } });
  assertTreasury(req.user!, before.treasuryDivisionId, "manage");
  const b = await prisma.bankAccount.update({ where: { id: before.id }, data: req.body });
  await audit(req, "bank.update", "BankAccount", b.id, before, b);
  ok(res, b);
});

// ───── Rencana iuran ─────

financeRoutes.get("/dues-plans", auth, async (req, res) => {
  const t = kasOf(req.query);
  assertTreasury(req.user!, t, "read");
  const plans = await prisma.duesPlan.findMany({ where: { deletedAt: null, treasuryDivisionId: t }, orderBy: { createdAt: "desc" }, include: { division: { select: { name: true } } } });
  const stats = await prisma.duesBill.groupBy({ by: ["planId", "status"], where: { planId: { in: plans.map((p) => p.id) } }, _count: true, _sum: { amount: true } });
  ok(
    res,
    plans.map((p) => {
      const s = stats.filter((x) => x.planId === p.id);
      const count = (st: string) => s.find((x) => x.status === st)?._count ?? 0;
      return { ...p, bills: { total: s.reduce((a, x) => a + x._count, 0), paid: count("PAID"), pending: count("PENDING"), overdue: count("OVERDUE") } };
    }),
  );
});

financeRoutes.post("/dues-plans", auth, validate(duesPlanSchema), async (req, res) => {
  const t = kasOf(req.query);
  assertTreasury(req.user!, t, "manage");
  // Kas divisi hanya bisa menagih anggota divisinya sendiri.
  const target = t ? { scope: "DIVISION" as const, divisionId: t } : { divisionId: req.body.scope === "DIVISION" ? req.body.divisionId : null };
  const plan = await prisma.duesPlan.create({ data: { ...req.body, ...target, treasuryDivisionId: t } });
  await audit(req, "duesPlan.create", "DuesPlan", plan.id, null, plan);
  const generated = await generateBills(plan);
  ok(res, { ...plan, generated }, undefined, 201);
});

// Nominal baru hanya berlaku untuk tagihan periode berikutnya.
financeRoutes.patch("/dues-plans/:id", auth, validate(updateDuesPlanSchema), async (req, res) => {
  const before = await prisma.duesPlan.findUniqueOrThrow({ where: { id: id(req.params.id) } });
  assertTreasury(req.user!, before.treasuryDivisionId, "manage");
  const plan = await prisma.duesPlan.update({ where: { id: before.id }, data: req.body });
  await audit(req, "duesPlan.update", "DuesPlan", plan.id, before, plan);
  ok(res, plan);
});

financeRoutes.post("/dues-plans/:id/generate", auth, async (req, res) => {
  const plan = await prisma.duesPlan.findUniqueOrThrow({ where: { id: id(req.params.id) } });
  assertTreasury(req.user!, plan.treasuryDivisionId, "manage");
  ok(res, { generated: await generateBills(plan) });
});

// ───── Tagihan ─────

const billInclude = { plan: { select: { name: true, frequency: true, treasuryDivisionId: true } } } as const;
const withLabel = <T extends { periodLabel: string }>(b: T) => ({ ...b, periodName: BILL_LABEL(b.periodLabel) });

financeRoutes.get("/bills/me", auth, async (req, res) => {
  const bills = await prisma.duesBill.findMany({ where: { userId: req.user!.id }, orderBy: [{ dueDate: "desc" }], include: billInclude, take: 100 });
  ok(res, bills.map(withLabel));
});

financeRoutes.get("/bills", auth, async (req, res) => {
  const t = kasOf(req.query);
  assertTreasury(req.user!, t, "read");
  const { skip, take, page } = paging(req.query);
  const where: Prisma.DuesBillWhereInput = { plan: { treasuryDivisionId: t } };
  if (req.query.status) where.status = String(req.query.status) as Prisma.EnumBillStatusFilter["equals"];
  if (req.query.planId) where.planId = String(req.query.planId);
  if (req.query.q) where.user = { name: { contains: String(req.query.q) } };
  const [rows, total] = await Promise.all([
    prisma.duesBill.findMany({ where, skip, take, orderBy: [{ dueDate: "desc" }, { user: { name: "asc" } }], include: { ...billInclude, user: { select: { id: true, name: true } } } }),
    prisma.duesBill.count({ where }),
  ]);
  ok(res, rows.map(withLabel), { page, total });
});

// ───── Pembayaran ─────

financeRoutes.post("/payments", auth, validate(paymentSchema), async (req, res) => {
  const u = req.user!;
  const bills = await prisma.duesBill.findMany({ where: { id: { in: req.body.billIds }, userId: u.id }, include: { plan: { select: { treasuryDivisionId: true } } } });
  if (bills.length !== req.body.billIds.length) throw new AppError("VALIDATION", 400, "Tagihan tidak ditemukan");
  // Satu bukti transfer = satu rekening tujuan, jadi tagihan dari kas berbeda dibayar terpisah.
  const kas = [...new Set(bills.map((b) => b.plan.treasuryDivisionId))];
  if (kas.length > 1) throw new AppError("VALIDATION", 400, "Bayar tagihan kas organisasi dan kas divisi secara terpisah (rekening tujuannya berbeda)");
  const t = kas[0] ?? null;
  if (bills.some((b) => !["UNPAID", "REJECTED", "OVERDUE"].includes(b.status))) throw new AppError("VALIDATION", 400, "Ada tagihan yang sudah dibayar atau sedang diverifikasi");
  const total = bills.reduce((s, b) => s + b.amount, 0);
  if (req.body.amount < total) throw new AppError("VALIDATION", 400, `Nominal kurang dari total tagihan (${rupiah(total)})`);
  const proofUrl = await ownUpload(req.body.proofId, u.id);

  const payment = await prisma.$transaction(async (tx) => {
    const p = await tx.payment.create({
      data: { userId: u.id, amount: req.body.amount, transferDate: req.body.transferDate, proofUrl, treasuryDivisionId: t, bills: { create: bills.map((b) => ({ billId: b.id })) } },
    });
    // Filter status lagi di dalam transaksi supaya dua kiriman bersamaan tidak membayar tagihan yang sama.
    const n = await tx.duesBill.updateMany({ where: { id: { in: bills.map((b) => b.id) }, status: { in: ["UNPAID", "REJECTED", "OVERDUE"] } }, data: { status: "PENDING" } });
    if (n.count !== bills.length) throw new AppError("CONFLICT", 409, "Tagihan sedang diproses, muat ulang halaman");
    return p;
  });
  const me = await prisma.user.findUnique({ where: { id: u.id }, select: { name: true } });
  await notify(await treasuryManagers(t), { type: "PAYMENT_NEW", title: `Bukti bayar dari ${me?.name}`, body: rupiah(payment.amount), link: kasLink(t, "verify") });
  ok(res, payment, undefined, 201);
});

const paymentInclude = {
  user: { select: { id: true, name: true, nim: true } },
  verifiedBy: { select: { name: true } },
  bills: { include: { bill: { include: billInclude } } },
} as const;

financeRoutes.get("/payments", auth, async (req, res) => {
  const u = req.user!;
  const t = kasOf(req.query);
  const where: Prisma.PaymentWhereInput = req.query.mine !== "1" && canReadTreasury(u, t) ? { treasuryDivisionId: t } : { userId: u.id };
  if (req.query.status) where.status = String(req.query.status) as "PENDING" | "VERIFIED" | "REJECTED";
  const { skip, take, page } = paging(req.query);
  const [rows, total] = await Promise.all([
    prisma.payment.findMany({ where, skip, take, orderBy: { createdAt: req.query.status === "PENDING" ? "asc" : "desc" }, include: paymentInclude }),
    prisma.payment.count({ where }),
  ]);
  ok(res, rows.map((p) => ({ ...p, bills: p.bills.map((x) => withLabel(x.bill)) })), { page, total });
});

financeRoutes.get("/payments/:id", auth, async (req, res) => {
  const p = await prisma.payment.findUniqueOrThrow({ where: { id: id(req.params.id) }, include: paymentInclude });
  if (p.userId !== req.user!.id && !canReadTreasury(req.user!, p.treasuryDivisionId)) throw new AppError("FORBIDDEN", 403, "Tidak punya akses");
  ok(res, { ...p, bills: p.bills.map((x) => withLabel(x.bill)) });
});

financeRoutes.post("/payments/:id/verify", auth, async (req, res) => {
  const p = await prisma.payment.findUniqueOrThrow({ where: { id: id(req.params.id) }, include: { bills: { include: { bill: { include: billInclude } } }, user: { select: { name: true } } } });
  assertTreasury(req.user!, p.treasuryDivisionId, "manage");
  if (p.status !== "PENDING") throw new AppError("INVALID_STATE", 409, "Pembayaran sudah diproses");
  const periodId = (await prisma.period.findFirstOrThrow({ where: { isActive: true } })).id;

  // Verifikasi + buku kas + poin dalam satu transaksi (PRD bagian 12).
  await prisma.$transaction(async (tx) => {
    const n = await tx.payment.updateMany({ where: { id: p.id, status: "PENDING" }, data: { status: "VERIFIED", verifiedById: req.user!.id } });
    if (n.count === 0) throw new AppError("INVALID_STATE", 409, "Pembayaran sudah diproses");
    await tx.duesBill.updateMany({ where: { id: { in: p.bills.map((b) => b.billId) } }, data: { status: "PAID" } });
    await tx.cashTransaction.create({
      data: { treasuryDivisionId: p.treasuryDivisionId, type: "IN", category: "Kas anggota", amount: p.amount, date: p.transferDate, description: `${p.user.name}: ${p.bills.map((b) => `${b.bill.plan.name} ${BILL_LABEL(b.bill.periodLabel)}`).join(", ")}`, refType: "Payment", refId: p.id },
    });
    for (const { bill } of p.bills) {
      if (p.transferDate <= bill.dueDate) await award(tx, { userId: p.userId, periodId, ruleKey: "KAS_ON_TIME", sourceType: "KAS", sourceId: bill.id, createdById: req.user!.id, note: `Bayar kas tepat waktu: ${BILL_LABEL(bill.periodLabel)}` });
    }
    await audit(req, "payment.verify", "Payment", p.id, { status: p.status }, { status: "VERIFIED" }, tx);
  });
  await notify([p.userId], { type: "PAYMENT_VERIFIED", title: "Pembayaran kas diverifikasi", body: `${rupiah(p.amount)} sudah tercatat lunas.`, link: `/dashboard/finance/receipt/${p.id}` });
  ok(res, { id: p.id, status: "VERIFIED" });
});

financeRoutes.post("/payments/:id/reject", auth, validate(rejectSchema), async (req, res) => {
  const p = await prisma.payment.findUniqueOrThrow({ where: { id: id(req.params.id) }, include: { bills: true } });
  assertTreasury(req.user!, p.treasuryDivisionId, "manage");
  if (p.status !== "PENDING") throw new AppError("INVALID_STATE", 409, "Pembayaran sudah diproses");
  await prisma.$transaction(async (tx) => {
    await tx.payment.update({ where: { id: p.id }, data: { status: "REJECTED", rejectReason: req.body.reason, verifiedById: req.user!.id } });
    await tx.duesBill.updateMany({ where: { id: { in: p.bills.map((b) => b.billId) } }, data: { status: "REJECTED" } });
    await audit(req, "payment.reject", "Payment", p.id, { status: p.status }, { status: "REJECTED", reason: req.body.reason }, tx);
  });
  await notify([p.userId], { type: "PAYMENT_REJECTED", title: "Bukti bayar ditolak", body: `${req.body.reason}. Silakan upload ulang.`, link: "/dashboard/finance" });
  ok(res, { id: p.id, status: "REJECTED" });
});

// ───── Buku kas ─────

financeRoutes.get("/cash-transactions", auth, async (req, res) => {
  const t = kasOf(req.query);
  assertTreasury(req.user!, t, "read");
  const { skip, take, page } = paging(req.query);
  const where: Prisma.CashTransactionWhereInput = { deletedAt: null, treasuryDivisionId: t };
  if (req.query.type) where.type = String(req.query.type) as "IN" | "OUT";
  if (req.query.from || req.query.to) where.date = { ...(req.query.from ? { gte: new Date(String(req.query.from)) } : {}), ...(req.query.to ? { lt: new Date(String(req.query.to)) } : {}) };
  const [rows, total] = await Promise.all([prisma.cashTransaction.findMany({ where, skip, take, orderBy: [{ date: "desc" }, { createdAt: "desc" }] }), prisma.cashTransaction.count({ where })]);
  ok(res, rows, { page, total });
});

financeRoutes.post("/cash-transactions", auth, validate(cashTransactionSchema), async (req, res) => {
  const kas = kasOf(req.query);
  assertTreasury(req.user!, kas, "manage");
  const { attachmentId, ...data } = req.body;
  const t = await prisma.cashTransaction.create({ data: { ...data, treasuryDivisionId: kas, attachmentUrl: attachmentId ? await ownUpload(attachmentId, req.user!.id) : undefined } });
  await audit(req, "cash.create", "CashTransaction", t.id, null, t);
  ok(res, t, undefined, 201);
});

financeRoutes.delete("/cash-transactions/:id", auth, async (req, res) => {
  const t = await prisma.cashTransaction.findUniqueOrThrow({ where: { id: id(req.params.id) } });
  assertTreasury(req.user!, t.treasuryDivisionId, "manage");
  if (t.refType === "Payment") throw new AppError("VALIDATION", 400, "Transaksi dari pembayaran kas tidak bisa dihapus");
  await prisma.cashTransaction.update({ where: { id: t.id }, data: { deletedAt: new Date() } });
  await audit(req, "cash.delete", "CashTransaction", t.id, t, null);
  ok(res, null);
});

financeRoutes.get("/finance/summary", auth, async (req, res) => {
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
financeRoutes.get("/finance/report/export", auth, async (req, res) => {
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
