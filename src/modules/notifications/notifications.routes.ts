import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { auth } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import { ok } from "../../utils/response.js";

export const notificationsRoutes = Router();

notificationsRoutes.get("/notifications", auth, async (req, res) => {
  const where = { userId: req.user!.id };
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, take: 40 }),
    prisma.notification.count({ where: { ...where, readAt: null } }),
  ]);
  ok(res, { items, unread });
});

// Tanpa ids = tandai semua sudah dibaca.
notificationsRoutes.post("/notifications/read", auth, validate(z.object({ ids: z.array(z.string()).optional() })), async (req, res) => {
  await prisma.notification.updateMany({
    where: { userId: req.user!.id, readAt: null, ...(req.body.ids ? { id: { in: req.body.ids } } : {}) },
    data: { readAt: new Date() },
  });
  ok(res, null);
});
