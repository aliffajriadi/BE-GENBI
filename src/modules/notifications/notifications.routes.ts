import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { auth } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import { ok } from "../../utils/response.js";

export const notificationsRoutes = Router();

notificationsRoutes.get("/notifications", auth, async (req, res) => {
  // ?unread=1 → hanya yang belum dibaca; ?cursor=<id terakhir> → halaman berikutnya (urut terbaru dulu).
  const userId = req.user!.id;
  const take = Math.min(Number(req.query.limit) || 40, 50);
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const [rows, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { userId, ...(req.query.unread === "1" ? { readAt: null } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);
  const items = rows.slice(0, take);
  ok(res, { items, unread, nextCursor: rows.length > take ? items.at(-1)!.id : null });
});

// Tanpa ids = tandai semua sudah dibaca.
notificationsRoutes.post("/notifications/read", auth, validate(z.object({ ids: z.array(z.string()).optional() })), async (req, res) => {
  await prisma.notification.updateMany({
    where: { userId: req.user!.id, readAt: null, ...(req.body.ids ? { id: { in: req.body.ids } } : {}) },
    data: { readAt: new Date() },
  });
  ok(res, null);
});
