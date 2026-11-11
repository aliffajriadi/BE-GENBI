import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { auth, requirePermission } from "../../middlewares/auth.js";
import { ok } from "../../utils/response.js";
import { paging } from "../../utils/paging.js";

export const auditRoutes = Router();

auditRoutes.get("/audit-logs", auth, requirePermission("audit.read"), async (req, res) => {
  const { skip, take, page } = paging(req.query);
  const where = req.query.entity ? { entity: String(req.query.entity) } : {};
  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({ where, skip, take, orderBy: { createdAt: "desc" }, include: { actor: { select: { id: true, name: true } } } }),
    prisma.auditLog.count({ where }),
  ]);
  ok(res, rows, { page, total });
});
