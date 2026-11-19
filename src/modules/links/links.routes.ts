import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { auth, type AuthUser } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import { shortLinkSchema, updateShortLinkSchema } from "../../shared/index.js";
import { AppError } from "../../utils/app-error.js";
import { ok } from "../../utils/response.js";
import { audit } from "../audit/audit.service.js";

// Shortlink pakai domain sendiri (/l/<slug> di FE). Semua anggota bisa membuat; ubah/hapus: pembuat atau admin.manage.
export const linksRoutes = Router();

const canModify = (u: AuthUser, createdById: string) => createdById === u.id || u.permissions.has("admin.manage");
const taken = (e: unknown) => (e as { code?: string }).code === "P2002";

async function own(u: AuthUser, id: string) {
  const l = await prisma.shortLink.findUnique({ where: { id } });
  if (!l) throw new AppError("NOT_FOUND", 404, "Link tidak ditemukan");
  if (!canModify(u, l.createdById)) throw new AppError("FORBIDDEN", 403, "Hanya pembuat link atau admin yang bisa mengubah");
  return l;
}

// Publik: dipanggil route /l/<slug> di FE. Hitung klik lalu kembalikan tujuan.
linksRoutes.get("/public/links/:slug", async (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  const { count } = await prisma.shortLink.updateMany({ where: { slug, active: true }, data: { clicks: { increment: 1 } } });
  if (!count) throw new AppError("NOT_FOUND", 404, "Link tidak ditemukan atau nonaktif");
  const l = await prisma.shortLink.findUniqueOrThrow({ where: { slug }, select: { url: true, title: true } });
  ok(res, l);
});

linksRoutes.get("/links", auth, async (req, res) => {
  const rows = await prisma.shortLink.findMany({ orderBy: { createdAt: "desc" }, include: { createdBy: { select: { id: true, name: true } } } });
  ok(res, rows.map((l) => ({ ...l, canEdit: canModify(req.user!, l.createdById) })));
});

linksRoutes.post("/links", auth, validate(shortLinkSchema), async (req, res) => {
  try {
    const l = await prisma.shortLink.create({ data: { ...req.body, createdById: req.user!.id } });
    await audit(req, "link.create", "ShortLink", l.id, null, l);
    ok(res, l, undefined, 201);
  } catch (e) {
    if (taken(e)) throw new AppError("CONFLICT", 409, "Slug sudah dipakai, pilih yang lain");
    throw e;
  }
});

linksRoutes.patch("/links/:id", auth, validate(updateShortLinkSchema), async (req, res) => {
  const before = await own(req.user!, String(req.params.id));
  try {
    const l = await prisma.shortLink.update({ where: { id: before.id }, data: req.body });
    await audit(req, "link.update", "ShortLink", l.id, before, l);
    ok(res, l);
  } catch (e) {
    if (taken(e)) throw new AppError("CONFLICT", 409, "Slug sudah dipakai, pilih yang lain");
    throw e;
  }
});

linksRoutes.delete("/links/:id", auth, async (req, res) => {
  const l = await own(req.user!, String(req.params.id));
  await prisma.shortLink.delete({ where: { id: l.id } });
  await audit(req, "link.delete", "ShortLink", l.id, l, null);
  ok(res, null);
});
