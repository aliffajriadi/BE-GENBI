import { Router, type Request } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { auth, requirePermission } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import { AppError } from "../../utils/app-error.js";
import { ok } from "../../utils/response.js";
import { audit } from "../audit/audit.service.js";
import { app, appInfo, authorizeUrl, connect, disconnect, feed, makeState, readState, redirectFor, refreshFeed, saveApp, stored, webhookVerifyToken } from "./instagram.service.js";

export const instagramRoutes = Router();
const admin = [auth, requirePermission("settings.manage")];
const back = (status: string) => `${env.WEB_ORIGIN.split(",")[0].replace(/\/$/, "")}/dashboard/settings?tab=instagram&ig=${status}`;
// trust proxy aktif → protocol & host mengikuti X-Forwarded-* dari nginx / proxy Next.
const origin = (req: Request) => `${req.protocol}://${req.get("host")}`;

const appSchema = z.object({
  appId: z.string().trim().regex(/^\d{5,30}$/, "App ID berupa angka"),
  appSecret: z.union([z.literal(""), z.string().trim().regex(/^[A-Za-z0-9]{16,100}$/, "App Secret tidak valid")]).optional(),
  configId: z.string().trim().regex(/^\d{5,30}$/, "Config ID berupa angka"),
});

// Landing page (publik): membaca feed tersimpan di database; token tidak pernah keluar.
instagramRoutes.get("/public/instagram", async (_req, res) => {
  ok(res, await feed());
});

// Webhook: Meta mewajibkan endpoint https saat setup Unified Login. Kita hanya menjawab verifikasi.
instagramRoutes.get("/instagram/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === webhookVerifyToken()) return res.type("text/plain").send(String(req.query["hub.challenge"] ?? ""));
  res.sendStatus(403);
});
instagramRoutes.post("/instagram/webhook", (_req, res) => {
  res.sendStatus(200);
});

instagramRoutes.get("/instagram/status", ...admin, async (req, res) => {
  const s = await stored();
  const f = await feed();
  ok(res, {
    ...(await appInfo()),
    redirectUri: redirectFor(origin(req)),
    webhookUrl: redirectFor(origin(req)).replace(/callback$/, "webhook"),
    webhookVerifyToken: webhookVerifyToken(),
    connected: !!s,
    username: s?.username ?? null,
    expiresAt: s?.expiresAt ?? null,
    connectedAt: s?.connectedAt ?? null,
    feedAt: f?.fetchedAt ?? null,
  });
});

// App ID & secret dari Meta, diisi lewat web. Secret tidak pernah dikirim balik.
instagramRoutes.put("/instagram/app", ...admin, validate(appSchema), async (req, res) => {
  const { appId, appSecret, configId } = req.body as z.infer<typeof appSchema>;
  try {
    await saveApp({ appId, appSecret: appSecret || undefined, configId });
  } catch (e) {
    throw new AppError("VALIDATION", 400, (e as Error).message);
  }
  await audit(req, "instagram.app_update", "Page", "instagram-app", null, { appId, configId, secretChanged: !!appSecret });
  ok(res, await appInfo());
});

// Web memanggil ini (pakai token login) lalu mengarahkan browser ke URL izin Instagram.
instagramRoutes.get("/instagram/connect", ...admin, async (req, res) => {
  if (!(await app())) throw new AppError("NOT_CONFIGURED", 400, "Isi App ID, App Secret, dan Config ID dulu");
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

// Ambil ulang feed sekarang (tanpa menunggu job 30 menit).
instagramRoutes.post("/instagram/refresh", ...admin, async (_req, res) => {
  try {
    ok(res, { feedAt: (await refreshFeed())?.fetchedAt ?? null });
  } catch (e) {
    throw new AppError("INSTAGRAM_ERROR", 502, `Instagram menolak: ${(e as Error).message}`);
  }
});

instagramRoutes.delete("/instagram", ...admin, async (req, res) => {
  const s = await stored();
  await disconnect();
  await audit(req, "instagram.disconnect", "Page", "instagram", s ? { username: s.username } : null, null);
  ok(res, { connected: false });
});
