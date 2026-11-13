import { Router, type Request } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { auth, requirePermission } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import { AppError } from "../../utils/app-error.js";
import { ok } from "../../utils/response.js";
import { audit } from "../audit/audit.service.js";
import { app, appInfo, authorizeUrl, connect, disconnect, feed, makeState, readState, redirectFor, saveApp, stored } from "./instagram.service.js";

export const instagramRoutes = Router();
const admin = [auth, requirePermission("settings.manage")];
const back = (status: string) => `${env.WEB_ORIGIN.split(",")[0].replace(/\/$/, "")}/dashboard/settings?tab=instagram&ig=${status}`;
// trust proxy aktif → protocol & host mengikuti X-Forwarded-* dari nginx / proxy Next.
const origin = (req: Request) => `${req.protocol}://${req.get("host")}`;

const appSchema = z.object({
  appId: z.string().trim().regex(/^\d{5,30}$/, "Instagram app ID berupa angka"),
  appSecret: z.union([z.literal(""), z.string().trim().regex(/^[A-Za-z0-9]{16,100}$/, "App secret tidak valid")]).optional(),
});

// Landing page (publik): profil & postingan saja, token tidak pernah keluar.
instagramRoutes.get("/public/instagram", async (_req, res) => {
  ok(res, await feed());
});

instagramRoutes.get("/instagram/status", ...admin, async (req, res) => {
  const s = await stored();
  ok(res, { ...(await appInfo()), redirectUri: redirectFor(origin(req)), connected: !!s, username: s?.username ?? null, expiresAt: s?.expiresAt ?? null, connectedAt: s?.connectedAt ?? null });
});

// App ID & secret dari Meta, diisi lewat web. Secret tidak pernah dikirim balik.
instagramRoutes.put("/instagram/app", ...admin, validate(appSchema), async (req, res) => {
  const { appId, appSecret } = req.body as z.infer<typeof appSchema>;
  try {
    await saveApp(appId, appSecret || undefined);
  } catch (e) {
    throw new AppError("VALIDATION", 400, (e as Error).message);
  }
  await audit(req, "instagram.app_update", "Page", "instagram-app", null, { appId, secretChanged: !!appSecret });
  ok(res, await appInfo());
});

// Web memanggil ini (pakai token login) lalu mengarahkan browser ke URL izin Instagram.
instagramRoutes.get("/instagram/connect", ...admin, async (req, res) => {
  if (!(await app())) throw new AppError("NOT_CONFIGURED", 400, "Isi Instagram app ID dan app secret dulu");
  ok(res, { url: await authorizeUrl(makeState(req.user!.id), redirectFor(origin(req))) });
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
