import express from "express";
import cors from "cors";
import helmet from "helmet";
import { env } from "./config/env.js";
import { errorHandler } from "./middlewares/error-handler.js";
import { auditRoutes } from "./modules/audit/audit.routes.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { dashboardRoutes } from "./modules/dashboard/dashboard.routes.js";
import { eventsRoutes } from "./modules/events/events.routes.js";
import { publicRoutes } from "./modules/public/public.routes.js";
import { pointsRoutes } from "./modules/points/points.routes.js";
import { usersRoutes } from "./modules/users/users.routes.js";
import { membersRoutes } from "./modules/users/members.routes.js";
import { divisionAccessRoutes } from "./modules/users/division-access.routes.js";
import { userImportRoutes } from "./modules/users/import.routes.js";
import { administrationRoutes } from "./modules/administration/administration.routes.js";
import { articlesRoutes } from "./modules/articles/articles.routes.js";
import { financeRoutes } from "./modules/finance/finance.routes.js";
import { notificationsRoutes } from "./modules/notifications/notifications.routes.js";
import { uploadsRoutes } from "./modules/uploads/uploads.routes.js";
import { chatRoutes } from "./modules/chat/chat.routes.js";
import { planningRoutes } from "./modules/planning/planning.routes.js";
import { downloadsRoutes } from "./modules/downloads/downloads.routes.js";
import { instagramRoutes } from "./modules/instagram/instagram.routes.js";
import { publicDir } from "./lib/storage.js";

export const app = express();

// Percaya proxy lokal/LAN (proxy Next, tunnel, Nginx Proxy Manager) supaya rate limit memakai IP asli pengguna.
app.set("trust proxy", "loopback, uniquelocal");
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
// WEB_ORIGIN: daftar origin dipisah koma, atau "*" untuk semua origin (aman karena login pakai header Bearer, bukan cookie).
app.use(cors({ origin: env.WEB_ORIGIN.trim() === "*" ? true : env.WEB_ORIGIN.split(",").map((o) => o.trim()) }));
app.use(express.json({ limit: "1mb" }));

// Gambar artikel publik; file privat hanya lewat GET /api/v1/files/:id.
app.use("/storage/public", express.static(publicDir, { maxAge: "7d" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

const v1 = express.Router();
v1.use(publicRoutes, authRoutes, userImportRoutes, usersRoutes, membersRoutes, divisionAccessRoutes, eventsRoutes, pointsRoutes, dashboardRoutes, auditRoutes, uploadsRoutes, notificationsRoutes, financeRoutes, articlesRoutes, administrationRoutes, chatRoutes, planningRoutes, downloadsRoutes, instagramRoutes);
app.use("/api/v1", v1);

app.use((_req, res) => res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Endpoint tidak ada" } }));
app.use(errorHandler);
