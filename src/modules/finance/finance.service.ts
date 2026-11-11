import { prisma, type DuesPlan } from "../../lib/prisma.js";
import { notify } from "../notifications/notifications.service.js";
import { billPeriod, BILL_LABEL } from "./billing.js";

const rupiah = (n: number) => `Rp${n.toLocaleString("id-ID")}`;

// Buat tagihan periode berjalan untuk semua peserta rencana iuran. Idempoten (unique planId+userId+periodLabel).
export async function generateBills(plan: DuesPlan, now = new Date()) {
  if (!plan.isActive || plan.deletedAt) return 0;
  const { label, dueDate } = billPeriod(plan, now);
  const members = await prisma.membership.findMany({
    where: {
      period: { isActive: true },
      user: { status: "ACTIVE", deletedAt: null },
      role: { key: { not: "SYS_ADMIN" } },
      ...(plan.scope === "DIVISION" ? { divisionId: plan.divisionId } : {}),
    },
    select: { userId: true },
  });
  const existing = new Set(
    (await prisma.duesBill.findMany({ where: { planId: plan.id, periodLabel: label }, select: { userId: true } })).map((b) => b.userId),
  );
  const fresh = members.map((m) => m.userId).filter((id) => !existing.has(id));
  if (!fresh.length) return 0;
  await prisma.duesBill.createMany({
    data: fresh.map((userId) => ({ planId: plan.id, userId, periodLabel: label, amount: plan.amount, dueDate })),
    skipDuplicates: true,
  });
  await notify(fresh, {
    type: "BILL_NEW",
    title: `Tagihan ${plan.name} ${BILL_LABEL(label)}`,
    body: `${rupiah(plan.amount)}, jatuh tempo ${dueDate.toLocaleDateString("id-ID", { day: "numeric", month: "long", timeZone: "Asia/Jakarta" })}`,
    link: "/dashboard/finance",
  });
  return fresh.length;
}

// Job harian: tagihan periode baru, tandai menunggak, pengingat H-3.
export async function dailyBilling(now = new Date()) {
  const plans = await prisma.duesPlan.findMany({ where: { isActive: true, deletedAt: null, frequency: { in: ["MONTHLY", "SEMESTER"] } } });
  for (const p of plans) await generateBills(p, now);

  const overdue = await prisma.duesBill.findMany({ where: { status: { in: ["UNPAID", "REJECTED"] }, dueDate: { lt: now } }, include: { plan: true } });
  if (overdue.length) {
    await prisma.duesBill.updateMany({ where: { id: { in: overdue.map((b) => b.id) } }, data: { status: "OVERDUE" } });
    for (const b of overdue) {
      await notify([b.userId], { type: "BILL_OVERDUE", title: `Tagihan ${b.plan.name} menunggak`, body: `${rupiah(b.amount)} · ${BILL_LABEL(b.periodLabel)}`, link: "/dashboard/finance" });
    }
  }

  // Tepat sekali: tagihan yang jatuh tempo antara 2 dan 3 hari lagi.
  const soon = await prisma.duesBill.findMany({
    where: { status: "UNPAID", dueDate: { gte: new Date(now.getTime() + 2 * 864e5), lt: new Date(now.getTime() + 3 * 864e5) } },
    include: { plan: true },
  });
  for (const b of soon) {
    await notify([b.userId], { type: "BILL_REMINDER", title: `Pengingat: ${b.plan.name} jatuh tempo 3 hari lagi`, body: rupiah(b.amount), link: "/dashboard/finance" });
  }
}
