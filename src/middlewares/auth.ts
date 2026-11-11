import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma.js";
import { DIVISION_AREAS, type DivisionArea, type PermissionKey, type RoleKey } from "../shared/index.js";
import { env } from "../config/env.js";
import { cache } from "../lib/cache.js";
import { AppError } from "../utils/app-error.js";

export type AuthUser = {
  id: string;
  role: RoleKey;
  divisionId: string | null;
  periodId: string;
  permissions: Set<PermissionKey>;
  divisionGrants: Set<DivisionArea>; // akses yang didelegasikan Kadiv, hanya berlaku di divisinya
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export type AccessPayload = { sub: string; role: RoleKey; div: string | null; per: string };

export async function permissionsFor(role: RoleKey): Promise<Set<PermissionKey>> {
  const key = `perms:${role}`;
  const hit = cache.get<Set<PermissionKey>>(key);
  if (hit) return hit;
  const rows = await prisma.rolePermission.findMany({ where: { role: { key: role } }, include: { permission: true } });
  const set = new Set(rows.map((r) => r.permission.key as PermissionKey));
  cache.set(key, set);
  return set;
}

// Akses delegasi per (user, divisi), di-cache 60 detik; dihapus dari cache saat Kadiv mengubahnya.
export const grantsKey = (userId: string, divisionId: string) => `grants:${userId}:${divisionId}`;
async function grantsFor(userId: string, divisionId: string | null): Promise<Set<DivisionArea>> {
  if (!divisionId) return new Set();
  const key = grantsKey(userId, divisionId);
  const hit = cache.get<Set<DivisionArea>>(key);
  if (hit) return hit;
  const rows = await prisma.divisionGrant.findMany({ where: { userId, divisionId }, select: { area: true } });
  const set = new Set(rows.map((r) => r.area as DivisionArea).filter((a) => a in DIVISION_AREAS));
  cache.set(key, set, 60);
  return set;
}

export async function buildUser(p: AccessPayload): Promise<AuthUser> {
  const base = await permissionsFor(p.role);
  const divisionGrants = await grantsFor(p.sub, p.div);
  // Salin, jangan ubah Set milik cache role.
  const permissions = divisionGrants.size ? new Set([...base, ...[...divisionGrants].flatMap((a) => DIVISION_AREAS[a].permissions)]) : base;
  return { id: p.sub, role: p.role, divisionId: p.div, periodId: p.per, permissions, divisionGrants };
}

export const auth: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw new AppError("UNAUTHENTICATED", 401, "Silakan login");
  let p: AccessPayload;
  try {
    p = jwt.verify(header.slice(7), env.JWT_SECRET) as AccessPayload;
  } catch {
    throw new AppError("TOKEN_EXPIRED", 401, "Sesi habis, silakan refresh");
  }
  req.user = await buildUser(p);
  next();
};

export const requirePermission =
  (...perms: PermissionKey[]): RequestHandler =>
  (req, _res, next) => {
    if (!perms.some((p) => req.user!.permissions.has(p))) throw new AppError("FORBIDDEN", 403, "Tidak punya akses");
    next();
  };
