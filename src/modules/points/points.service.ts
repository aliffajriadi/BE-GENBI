import { prisma, type PointRule, type PointSource, type Prisma } from "../../lib/prisma.js";
import { cache } from "../../lib/cache.js";

type Db = Prisma.TransactionClient | typeof prisma;

export async function activeRules(): Promise<Map<string, PointRule>> {
  const hit = cache.get<Map<string, PointRule>>("pointRules");
  if (hit) return hit;
  const rules = await prisma.pointRule.findMany({ where: { isActive: true } });
  const map = new Map(rules.map((r) => [r.key, r]));
  cache.set("pointRules", map);
  return map;
}

export const invalidateRules = () => cache.del("pointRules");

// Tulis satu baris ledger. override (mis. poin per event) menang atas nilai aturan.
// Aturan nonaktif / poin 0 → tidak dicatat.
export async function award(
  db: Db,
  a: { userId: string; periodId: string; ruleKey: string; override?: number | null; sourceType: PointSource; sourceId?: string; createdById?: string; note?: string },
) {
  const rule = (await activeRules()).get(a.ruleKey);
  if (!rule) return null;
  const points = a.override ?? rule.points;
  if (points === 0) return null;
  return db.pointLedger.create({
    data: {
      userId: a.userId,
      periodId: a.periodId,
      points,
      sourceType: a.sourceType,
      sourceId: a.sourceId,
      createdById: a.createdById,
      note: a.note ?? rule.label,
    },
  });
}
