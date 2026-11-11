import { Router } from "express";
import type { z } from "zod";
import { prisma, type Article, type Prisma } from "../../lib/prisma.js";
import { auth, requirePermission, type AuthUser } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import { createArticleSchema, publishArticleSchema, updateArticleSchema } from "../../shared/index.js";
import { AppError } from "../../utils/app-error.js";
import { paging } from "../../utils/paging.js";
import { ok } from "../../utils/response.js";
import { audit } from "../audit/audit.service.js";
import { bodyOf, publishNow, slugify, uniqueSlug, unpublish } from "./articles.service.js";

export const articlesRoutes = Router();

// Tanpa approval: penulis menerbitkan tulisannya sendiri. Pemegang article.publish = moderator (bisa ubah/turunkan semua).
const isModerator = (u: AuthUser) => u.permissions.has("article.publish");
// Kabar/kegiatan organisasi hanya ditulis pengurus (Kadiv ke atas).
const canWriteNews = (u: AuthUser) => u.permissions.has("article.publish") || u.permissions.has("article.review");

async function load(u: AuthUser, id: string) {
  const a = await prisma.article.findFirst({
    where: { id, deletedAt: null },
    include: { author: { select: { id: true, name: true } }, division: { select: { name: true } }, tags: { include: { tag: true } } },
  });
  if (!a) throw new AppError("NOT_FOUND", 404, "Artikel tidak ditemukan");
  if (a.authorId !== u.id && !isModerator(u)) throw new AppError("FORBIDDEN", 403, "Tidak punya akses ke artikel ini");
  return a;
}

const view = (a: Awaited<ReturnType<typeof load>>, u: AuthUser) => {
  const { contentJson, contentHtml: _h, tags, ...rest } = a;
  return { ...rest, body: bodyOf({ contentJson }), tags: tags.map((t) => t.tag.name), canEdit: true, canModerate: isModerator(u), canWriteNews: canWriteNews(u) };
};

articlesRoutes.get("/articles", auth, requirePermission("article.write"), async (req, res) => {
  const u = req.user!;
  const where: Prisma.ArticleWhereInput = { deletedAt: null };
  if (req.query.scope === "all" && isModerator(u)) {
    if (req.query.status) where.status = String(req.query.status) as Article["status"];
  } else {
    where.authorId = u.id;
  }
  if (req.query.kind) where.kind = String(req.query.kind) as Article["kind"];
  const { skip, take, page } = paging(req.query);
  const [rows, total] = await Promise.all([
    prisma.article.findMany({
      where,
      skip,
      take,
      orderBy: { updatedAt: "desc" },
      select: { id: true, title: true, slug: true, status: true, kind: true, coverUrl: true, updatedAt: true, publishedAt: true, scheduledAt: true, viewCount: true, author: { select: { name: true } }, division: { select: { name: true } } },
    }),
    prisma.article.count({ where }),
  ]);
  ok(res, rows, { page, total });
});

articlesRoutes.post("/articles", auth, requirePermission("article.write"), validate(createArticleSchema), async (req, res) => {
  const u = req.user!;
  if (req.body.kind === "NEWS" && !canWriteNews(u)) throw new AppError("FORBIDDEN", 403, "Kabar organisasi hanya bisa ditulis pengurus");
  const a = await prisma.article.create({
    data: { title: req.body.title, kind: req.body.kind, slug: await uniqueSlug(req.body.title), authorId: u.id, divisionId: u.divisionId, contentJson: { body: "" } },
  });
  ok(res, a, undefined, 201);
});

articlesRoutes.get("/articles/:id", auth, async (req, res) => {
  ok(res, view(await load(req.user!, String(req.params.id)), req.user!));
});

articlesRoutes.patch("/articles/:id", auth, validate(updateArticleSchema), async (req, res) => {
  const u = req.user!;
  const a = await load(u, String(req.params.id));
  const { body, tags, slug, kind, ...data } = req.body as z.infer<typeof updateArticleSchema>;
  if (kind === "NEWS" && kind !== a.kind && !canWriteNews(u)) throw new AppError("FORBIDDEN", 403, "Kabar organisasi hanya bisa ditulis pengurus");
  if (slug && slug !== a.slug && (await prisma.article.count({ where: { slug } }))) throw new AppError("CONFLICT", 409, "Slug sudah dipakai artikel lain");

  await prisma.$transaction(async (tx) => {
    await tx.article.update({ where: { id: a.id }, data: { ...data, ...(kind ? { kind } : {}), ...(slug ? { slug } : {}), ...(body !== undefined ? { contentJson: { body } } : {}) } });
    // Revisi disimpan tiap isi berubah, paling sering sekali per 5 menit per artikel (autosave tidak membanjiri tabel).
    if (body !== undefined && body !== bodyOf(a)) {
      const last = await tx.articleRevision.findFirst({ where: { articleId: a.id }, orderBy: { createdAt: "desc" } });
      if (!last || Date.now() - last.createdAt.getTime() > 5 * 60_000) await tx.articleRevision.create({ data: { articleId: a.id, contentJson: { body: bodyOf(a) }, editorId: u.id } });
    }
    if (tags) {
      await tx.articleTag.deleteMany({ where: { articleId: a.id } });
      for (const name of [...new Set(tags.map((t) => t.trim()).filter(Boolean))]) {
        const tag = await tx.tag.upsert({ where: { slug: slugify(name) }, update: {}, create: { name, slug: slugify(name) } });
        await tx.articleTag.create({ data: { articleId: a.id, tagId: tag.id } });
      }
    }
  });
  if (a.authorId !== u.id) await audit(req, "article.moderate_edit", "Article", a.id, { title: a.title }, { title: data.title ?? a.title });
  ok(res, view(await load(u, a.id), u));
});

articlesRoutes.delete("/articles/:id", auth, async (req, res) => {
  const u = req.user!;
  const a = await load(u, String(req.params.id));
  if (a.status === "PUBLISHED") await unpublish(a.id, u.id); // balik poin sebelum dihapus
  await prisma.article.update({ where: { id: a.id }, data: { deletedAt: new Date() } });
  await audit(req, "article.delete", "Article", a.id, { title: a.title, status: a.status }, null);
  ok(res, null);
});

articlesRoutes.get("/articles/:id/revisions", auth, async (req, res) => {
  const a = await load(req.user!, String(req.params.id));
  const revs = await prisma.articleRevision.findMany({ where: { articleId: a.id }, orderBy: { createdAt: "desc" }, take: 30, include: { editor: { select: { name: true } } } });
  ok(res, revs.map((r) => ({ id: r.id, createdAt: r.createdAt, editor: r.editor.name, body: bodyOf(r) })));
});

articlesRoutes.post("/articles/:id/publish", auth, validate(publishArticleSchema), async (req, res) => {
  const u = req.user!;
  const a = await load(u, String(req.params.id));
  if (a.status === "PUBLISHED") throw new AppError("INVALID_STATE", 409, "Artikel sudah tayang");
  if (bodyOf(a).trim().split(/\s+/).length < 30) throw new AppError("VALIDATION", 400, "Isi artikel minimal 30 kata sebelum diterbitkan");
  const when: Date | undefined = req.body.scheduledAt;
  if (when && when > new Date()) {
    await prisma.article.update({ where: { id: a.id }, data: { status: "SCHEDULED", scheduledAt: when } });
    return ok(res, { status: "SCHEDULED" });
  }
  await publishNow(a.id, u.id);
  await audit(req, "article.publish", "Article", a.id, { status: a.status }, { status: "PUBLISHED" });
  ok(res, { status: "PUBLISHED" });
});

// Penulis menarik tulisannya, atau moderator menurunkan konten yang melanggar.
articlesRoutes.post("/articles/:id/archive", auth, async (req, res) => {
  const a = await load(req.user!, String(req.params.id));
  await unpublish(a.id, req.user!.id);
  await audit(req, "article.archive", "Article", a.id, { status: a.status }, { status: "ARCHIVED" });
  ok(res, { status: "ARCHIVED" });
});

// ───── Publik ─────

const publicSelect = {
  id: true, title: true, slug: true, kind: true, excerpt: true, coverUrl: true, coverAlt: true, publishedAt: true,
  author: { select: { id: true, name: true, avatarUrl: true, profilePublic: true } }, division: { select: { name: true } }, tags: { select: { tag: { select: { name: true, slug: true } } } },
} as const;

articlesRoutes.get("/public/articles", async (req, res) => {
  const { skip, take, page } = paging({ ...req.query, limit: req.query.limit ?? 12 });
  const where: Prisma.ArticleWhereInput = { status: "PUBLISHED", deletedAt: null };
  if (req.query.kind === "NEWS" || req.query.kind === "PERSONAL") where.kind = req.query.kind;
  if (req.query.tag) where.tags = { some: { tag: { slug: String(req.query.tag) } } };
  if (req.query.q) where.OR = [{ title: { contains: String(req.query.q) } }, { excerpt: { contains: String(req.query.q) } }];
  const [rows, total] = await Promise.all([prisma.article.findMany({ where, skip, take, orderBy: { publishedAt: "desc" }, select: { ...publicSelect, contentJson: true } }), prisma.article.count({ where })]);
  // Hitung menit baca di server supaya daftar tidak perlu mengirim isi penuh.
  ok(res, rows.map(({ contentJson, ...r }) => ({ ...r, tags: r.tags.map((t) => t.tag), readMinutes: Math.max(1, Math.round(bodyOf({ contentJson }).split(/\s+/).length / 200)) })), { page, total });
});

articlesRoutes.get("/public/articles/:slug", async (req, res) => {
  const a = await prisma.article.findFirst({ where: { slug: String(req.params.slug), status: "PUBLISHED", deletedAt: null }, select: { ...publicSelect, contentJson: true, seoTitle: true, seoDesc: true, viewCount: true } });
  if (!a) throw new AppError("NOT_FOUND", 404, "Artikel tidak ditemukan");
  if (req.query.view === "1") await prisma.article.update({ where: { id: a.id }, data: { viewCount: { increment: 1 } } });
  const { contentJson, ...rest } = a;
  ok(res, { ...rest, body: bodyOf({ contentJson }), tags: a.tags.map((t) => t.tag) });
});

articlesRoutes.get("/public/tags", async (req, res) => {
  const kind = req.query.kind === "NEWS" || req.query.kind === "PERSONAL" ? req.query.kind : undefined;
  ok(res, await prisma.tag.findMany({ where: { articles: { some: { article: { status: "PUBLISHED", deletedAt: null, ...(kind ? { kind } : {}) } } } }, orderBy: { name: "asc" } }));
});
