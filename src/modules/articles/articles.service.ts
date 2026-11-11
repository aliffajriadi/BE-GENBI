import crypto from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { notify } from "../notifications/notifications.service.js";
import { award } from "../points/points.service.js";

export const slugify = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "artikel";

export async function uniqueSlug(title: string) {
  const base = slugify(title);
  return (await prisma.article.count({ where: { slug: base } })) ? `${base}-${crypto.randomBytes(3).toString("hex")}` : base;
}

// Isi artikel disimpan sebagai markdown di contentJson.body.
export const bodyOf = (a: { contentJson: unknown }) => ((a.contentJson as { body?: string } | null)?.body ?? "");

// Tayangkan artikel + poin ke penulis. Dipakai tombol publish & job publish terjadwal.
export async function publishNow(articleId: string, actorId?: string) {
  const period = await prisma.period.findFirst({ where: { isActive: true } });
  const a = await prisma.$transaction(async (tx) => {
    const art = await tx.article.update({ where: { id: articleId }, data: { status: "PUBLISHED", publishedAt: new Date(), scheduledAt: null } });
    // Saldo poin artikel ini 0 (belum pernah, atau sudah dibalik saat diturunkan) → beri poin.
    const net = (await tx.pointLedger.aggregate({ where: { sourceType: "ARTICLE", sourceId: art.id }, _sum: { points: true } }))._sum.points ?? 0;
    if (period && net === 0) await award(tx, { userId: art.authorId, periodId: period.id, ruleKey: "ARTICLE_PUBLISHED", sourceType: "ARTICLE", sourceId: art.id, createdById: actorId, note: `Artikel tayang: ${art.title}` });
    return art;
  });
  if (actorId !== a.authorId) await notify([a.authorId], { type: "ARTICLE_PUBLISHED", title: "Artikelmu tayang", body: a.title, link: `/artikel/${a.slug}` });
  return a;
}

// Turunkan dari web; poin artikel dibalik supaya tidak bisa dikumpulkan dengan tulisan yang lalu dihapus.
export async function unpublish(articleId: string, actorId: string) {
  const period = await prisma.period.findFirst({ where: { isActive: true } });
  return prisma.$transaction(async (tx) => {
    const art = await tx.article.update({ where: { id: articleId }, data: { status: "ARCHIVED", scheduledAt: null } });
    const net = (await tx.pointLedger.aggregate({ where: { sourceType: "ARTICLE", sourceId: art.id }, _sum: { points: true } }))._sum.points ?? 0;
    if (period && net !== 0) {
      await tx.pointLedger.create({ data: { userId: art.authorId, periodId: period.id, points: -net, sourceType: "ARTICLE", sourceId: art.id, createdById: actorId, note: `Artikel diturunkan: ${art.title}` } });
    }
    return art;
  });
}
