import { randomUUID } from "node:crypto";
import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { auth, requirePermission } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import { downloadGuideSchema, type DownloadGuide } from "../../shared/index.js";
import { AppError } from "../../utils/app-error.js";
import { ok } from "../../utils/response.js";
import { audit } from "../audit/audit.service.js";

// Panduan unduh aplikasi: dibaca semua anggota yang login, dikelola System Administrator (settings.manage).
// Disimpan di tabel Page (slug "download/<id>") supaya tidak perlu tabel baru.
export const downloadsRoutes = Router();
const PREFIX = "download/";

const view = (p: { id: string; title: string; contentJson: unknown; updatedAt: Date }) => ({ id: p.id, ...(p.contentJson as DownloadGuide), title: p.title, updatedAt: p.updatedAt });

async function find(id: string) {
  const p = await prisma.page.findFirst({ where: { id, slug: { startsWith: PREFIX }, deletedAt: null } });
  if (!p) throw new AppError("NOT_FOUND", 404, "Panduan tidak ditemukan");
  return p;
}

downloadsRoutes.get("/downloads", auth, async (_req, res) => {
  const rows = await prisma.page.findMany({ where: { slug: { startsWith: PREFIX }, deletedAt: null }, orderBy: { createdAt: "asc" } });
  ok(res, rows.map(view).sort((a, b) => a.order - b.order));
});

downloadsRoutes.post("/downloads", auth, requirePermission("settings.manage"), validate(downloadGuideSchema), async (req, res) => {
  const body = req.body as DownloadGuide;
  const p = await prisma.page.create({ data: { slug: PREFIX + randomUUID(), title: body.title, contentJson: body } });
  await audit(req, "download.create", "Page", p.id, null, body);
  ok(res, view(p));
});

downloadsRoutes.put("/downloads/:id", auth, requirePermission("settings.manage"), validate(downloadGuideSchema), async (req, res) => {
  const before = await find(String(req.params.id));
  const body = req.body as DownloadGuide;
  const p = await prisma.page.update({ where: { id: before.id }, data: { title: body.title, contentJson: body } });
  await audit(req, "download.update", "Page", p.id, before.contentJson, body);
  ok(res, view(p));
});

downloadsRoutes.delete("/downloads/:id", auth, requirePermission("settings.manage"), async (req, res) => {
  const p = await find(String(req.params.id));
  await prisma.page.update({ where: { id: p.id }, data: { deletedAt: new Date() } });
  await audit(req, "download.delete", "Page", p.id, p.contentJson, null);
  ok(res, { id: p.id });
});
