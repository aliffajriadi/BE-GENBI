// Perhitungan periode tagihan kas. Semua tanggal dihitung di zona WIB (UTC+7) apa pun zona server.
const WIB = 7 * 3_600_000;

type Plan = { frequency: "MONTHLY" | "SEMESTER" | "ONCE"; dueDay: number | null; dueDate: Date | null };

export function billPeriod(plan: Plan, now = new Date()): { label: string; dueDate: Date } {
  if (plan.frequency === "ONCE") return { label: "SEKALI", dueDate: plan.dueDate! };
  const local = new Date(now.getTime() + WIB);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const day = plan.dueDay ?? 10;
  if (plan.frequency === "MONTHLY") {
    return { label: `${y}-${String(m + 1).padStart(2, "0")}`, dueDate: endOfDayWib(y, m, day) };
  }
  const sem = m < 6 ? 1 : 2;
  return { label: `${y}-S${sem}`, dueDate: endOfDayWib(y, sem === 1 ? 0 : 6, day) };
}

function endOfDayWib(y: number, m: number, d: number) {
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, last), 23, 59, 59) - WIB);
}

export const BILL_LABEL = (label: string) => {
  if (label === "SEKALI") return "Sekali bayar";
  const [y, p] = label.split("-");
  if (p.startsWith("S")) return `Semester ${p.slice(1)} ${y}`;
  return new Date(Date.UTC(Number(y), Number(p) - 1, 1)).toLocaleDateString("id-ID", { month: "long", year: "numeric", timeZone: "UTC" });
};
