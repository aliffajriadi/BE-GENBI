import { Router } from "express";
import { prisma, type Prisma } from "../../lib/prisma.js";
import { auth } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import {
    bankAccountSchema, duesPlanSchema,
    paymentSchema,
    rejectSchema,
    updateDuesPlanSchema
} from "../../shared/index.js";
import { AppError } from "../../utils/app-error.js";
import { paging } from "../../utils/paging.js";
import { ok } from "../../utils/response.js";
import { audit } from "../audit/audit.service.js";
import { notify } from "../notifications/notifications.service.js";
import { award } from "../points/points.service.js";
import { BILL_LABEL } from "./billing.js";
import { generateBills } from "./finance.service.js";
import { assertTreasury, canManageTreasury, canReadTreasury, treasuryManagers } from "./treasury.js";
import { id, kasLink, kasOf, ownUpload, rupiah } from "./helpers.js";
import { cashRoutes } from "./cash.routes.js";

export const financeRoutes = Router();
// Buku kas, ringkasan & laporan ada di cash.routes.ts.
financeRoutes.use(cashRoutes);

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
