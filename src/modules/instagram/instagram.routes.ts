import { Router } from "express";
import { env } from "../../config/env.js";
import { auth, requirePermission } from "../../middlewares/auth.js";
import { AppError } from "../../utils/app-error.js";
import { ok } from "../../utils/response.js";
import { audit } from "../audit/audit.service.js";
import { authorizeUrl, configured, connect, disconnect, feed, makeState, readState, redirectUri, stored } from "./instagram.service.js";

export const instagramRoutes = Router();
const admin = [auth, requirePermission("settings.manage")];
const back = (status: string) => `${env.WEB_ORIGIN.split(",")[0].replace(/\/$/, "")}/dashboard/settings?tab=instagram&ig=${status}`;

// Landing page (publik): profil & postingan saja, token tidak pernah keluar.
instagramRoutes.get("/public/instagram", async (_req, res) => {
  ok(res, await feed());
});

instagramRoutes.get("/instagram/status", ...admin, async (_req, res) => {
  const s = await stored();
  ok(res, { configured: configured(), redirectUri: redirectUri(), connected: !!s, username: s?.username ?? null, expiresAt: s?.expiresAt ?? null, connectedAt: s?.connectedAt ?? null });
});

// Web memanggil ini (pakai token login) lalu mengarahkan browser ke URL izin Instagram.
instagramRoutes.get("/instagram/connect", ...admin, async (req, res) => {
  if (!configured()) throw new AppError("NOT_CONFIGURED", 400, "IG_APP_ID dan IG_APP_SECRET belum diisi di .env backend");
  ok(res, { url: authorizeUrl(makeState(req.user!.id)) });
});

// Instagram mengarahkan browser kembali ke sini (tanpa header login) → keabsahan dicek lewat state bertanda tangan.
instagramRoutes.get("/instagram/callback", async (req, res) => {
  const userId = readState(String(req.query.state ?? ""));
  if (!userId || !req.query.code) return res.redirect(back(req.query.error ? "denied" : "invalid"));
  try {
    const s = await connect(String(req.query.code));
    await audit(req, "instagram.connect", "Page", "instagram", null, { username: s.username, by: userId });
    res.redirect(back("ok"));
  } catch (err) {
    console.error("instagram connect gagal", err);
    res.redirect(back("error"));
  }
});

instagramRoutes.delete("/instagram", ...admin, async (req, res) => {
  const s = await stored();
  await disconnect();
  await audit(req, "instagram.disconnect", "Page", "instagram", s ? { username: s.username } : null, null);
  ok(res, { connected: false });
});
