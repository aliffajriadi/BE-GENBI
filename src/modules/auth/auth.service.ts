import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../../lib/prisma.js";
import type { RoleKey } from "../../shared/index.js";
import { env } from "../../config/env.js";
import { AppError } from "../../utils/app-error.js";
import type { AccessPayload } from "../../middlewares/auth.js";

const REFRESH_DAYS = 30;
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export async function activeMembership(userId: string) {
  return prisma.membership.findFirst({
    where: { userId, period: { isActive: true } },
    include: { role: true, division: true, period: true },
  });
}

export async function issueTokens(userId: string, device?: string) {
  const m = await activeMembership(userId);
  if (!m) throw new AppError("NO_MEMBERSHIP", 403, "Akun belum punya jabatan di periode aktif");
  const payload: AccessPayload = { sub: userId, role: m.role.key as RoleKey, div: m.divisionId, per: m.periodId };
  const accessToken = jwt.sign(payload, env.JWT_SECRET, { expiresIn: "15m" });
  const refreshToken = crypto.randomBytes(48).toString("base64url");
  await prisma.refreshToken.create({
    data: { userId, tokenHash: sha256(refreshToken), device, expiresAt: new Date(Date.now() + REFRESH_DAYS * 864e5) },
  });
  return { accessToken, refreshToken };
}

export async function login(email: string, password: string, device?: string) {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  const valid = user && !user.deletedAt && (await bcrypt.compare(password, user.passwordHash));
  if (!valid) throw new AppError("INVALID_CREDENTIALS", 401, "Email atau password salah");
  if (user.status !== "ACTIVE") throw new AppError("INACTIVE", 403, "Akun tidak aktif");
  return issueTokens(user.id, device);
}

// Rotasi: token lama dicabut, token baru diterbitkan. Token lama yang dipakai ulang → semua sesi user dicabut.
export async function refresh(token: string) {
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!row || row.expiresAt < new Date()) throw new AppError("INVALID_REFRESH", 401, "Sesi berakhir, silakan login");
  if (row.revokedAt) {
    await prisma.refreshToken.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    throw new AppError("INVALID_REFRESH", 401, "Sesi berakhir, silakan login");
  }
  if (row.user.status !== "ACTIVE" || row.user.deletedAt) throw new AppError("INACTIVE", 403, "Akun tidak aktif");
  await prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
  return issueTokens(row.userId, row.device ?? undefined);
}

export async function logout(token: string) {
  await prisma.refreshToken.updateMany({ where: { tokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } });
}
