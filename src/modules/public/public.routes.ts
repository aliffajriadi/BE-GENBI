import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { auth, requirePermission } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import { siteSchema, type SiteContent } from "../../shared/index.js";
import { AppError } from "../../utils/app-error.js";
import { ok } from "../../utils/response.js";
import { audit } from "../audit/audit.service.js";
import { getIndicators } from "./bi-indicators.js";

// Data untuk landing page publik (tanpa login). Hanya data yang aman dipublikasikan.
export const publicRoutes = Router();

publicRoutes.get("/public/bi-indicators", async (_req, res) => {
  ok(res, await getIndicators());
});

publicRoutes.get("/public/stats", async (_req, res) => {
  const period = await prisma.period.findFirst({ where: { isActive: true } });
  const [members, divisions, events] = await Promise.all([
    prisma.membership.count({ where: { periodId: period?.id, user: { status: "ACTIVE", deletedAt: null }, role: { key: { not: "SYS_ADMIN" } } } }),
    prisma.division.count({ where: { periodId: period?.id } }),
    prisma.event.count({ where: { deletedAt: null, type: "KEGIATAN" } }),
  ]);
  ok(res, { period: period?.name ?? null, members, divisions, events });
});

publicRoutes.get("/public/events", async (_req, res) => {
  ok(
    res,
    await prisma.event.findMany({
      where: { deletedAt: null, type: { in: ["KEGIATAN", "KEPANITIAAN"] }, endAt: { gte: new Date() } },
      orderBy: { startAt: "asc" },
      take: 6,
      select: { id: true, title: true, type: true, startAt: true, endAt: true, location: true },
    }),
  );
});

publicRoutes.get("/public/divisions", async (_req, res) => {
  const period = await prisma.period.findFirst({ where: { isActive: true } });
  ok(res, await prisma.division.findMany({ where: { periodId: period?.id }, orderBy: { name: "asc" }, select: { id: true, name: true, description: true } }));
});

// Konten hero beranda disimpan di tabel Page (slug "beranda"), tanpa tabel baru.
const SITE_SLUG = "beranda";
const DEFAULT_SITE: SiteContent = {
  heroImage: null,
  heroAlt: "",
  headline: "Generasi Baru Indonesia",
  subheadline: "Komunitas mahasiswa penerima beasiswa Bank Indonesia. Kabar kegiatan, agenda, dan tulisan anggota ada di sini.",
};

publicRoutes.get("/public/site", async (_req, res) => {
  const page = await prisma.page.findUnique({ where: { slug: SITE_SLUG } });
  ok(res, { ...DEFAULT_SITE, ...((page?.contentJson as Partial<SiteContent> | null) ?? {}) });
});

// Pengurus inti (pemegang article.publish: Ketum, Sekretaris, admin) mengganti foto & teks hero.
publicRoutes.patch("/site", auth, requirePermission("article.publish"), validate(siteSchema), async (req, res) => {
  const body = req.body as SiteContent;
  if (body.heroImage) {
    const up = await prisma.upload.findUnique({ where: { key: body.heroImage.replace(/^\/storage\//, "") } });
    if (!up || up.isPrivate || !up.mime.startsWith("image/")) throw new AppError("VALIDATION", 400, "Foto latar harus gambar yang diupload lewat panel");
  }
  const before = await prisma.page.findUnique({ where: { slug: SITE_SLUG } });
  await prisma.page.upsert({ where: { slug: SITE_SLUG }, update: { contentJson: body }, create: { slug: SITE_SLUG, title: "Beranda", contentJson: body } });
  await audit(req, "site.update", "Page", SITE_SLUG, before?.contentJson ?? null, body);
  ok(res, body);
});

// ───── Halaman Anggota publik ─────
// Hanya data yang dipilih anggota untuk ditampilkan (foto, bio, medsos) + jabatan. Tanpa kontak, NIM, kampus, poin, atau absensi.
const publicProfile = { id: true, name: true, avatarUrl: true } as const;
const visible = { deletedAt: null, status: "ACTIVE", profilePublic: true } as const;

publicRoutes.get("/public/members", async (req, res) => {
  const period = await prisma.period.findFirst({ where: { isActive: true } });
  if (!period) return ok(res, []);
  const rows = await prisma.membership.findMany({
    where: { periodId: period.id, role: { key: { not: "SYS_ADMIN" } }, user: { ...visible, ...(req.query.q ? { name: { contains: String(req.query.q) } } : {}) } },
    select: { position: true, role: { select: { key: true, name: true } }, division: { select: { id: true, name: true } }, user: { select: publicProfile } },
    orderBy: { user: { name: "asc" } },
  });
  ok(res, rows.map((m) => ({ ...m.user, role: m.role.key, position: m.position ?? m.role.name, division: m.division })));
});

publicRoutes.get("/public/members/:id", async (req, res) => {
  const u = await prisma.user.findFirst({
    where: { id: String(req.params.id), ...visible },
    select: {
      ...publicProfile, coverUrl: true, bio: true, instagram: true, tiktok: true, linkedin: true, website: true,
      memberships: { orderBy: { createdAt: "desc" }, select: { position: true, role: { select: { key: true, name: true } }, division: { select: { name: true } }, period: { select: { name: true, isActive: true } } } },
      articles: {
        where: { status: "PUBLISHED", deletedAt: null }, orderBy: { publishedAt: "desc" }, take: 20,
        select: { id: true, title: true, slug: true, kind: true, excerpt: true, coverUrl: true, coverAlt: true, publishedAt: true },
      },
    },
  });
  if (!u || u.memberships.some((m) => m.role.key === "SYS_ADMIN" && m.period.isActive)) throw new AppError("NOT_FOUND", 404, "Profil tidak ditemukan");
  ok(res, u);
});
