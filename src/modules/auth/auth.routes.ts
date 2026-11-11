import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import bcrypt from "bcryptjs";
import { changePasswordSchema, loginSchema, refreshSchema, updateMeSchema } from "../../shared/index.js";
import { AppError } from "../../utils/app-error.js";
import { audit } from "../audit/audit.service.js";
import { auth } from "../../middlewares/auth.js";
import { loginLimiter } from "../../middlewares/rate-limit.js";
import { validate } from "../../middlewares/validate.js";
import { ok } from "../../utils/response.js";
import { memberToken } from "../events/qr.js";
import * as svc from "./auth.service.js";

export const authRoutes = Router();

authRoutes.post("/auth/login", loginLimiter, validate(loginSchema), async (req, res) => {
  ok(res, await svc.login(req.body.email, req.body.password, req.body.device));
});

authRoutes.post("/auth/refresh", validate(refreshSchema), async (req, res) => {
  ok(res, await svc.refresh(req.body.refreshToken));
});

authRoutes.post("/auth/logout", validate(refreshSchema), async (req, res) => {
  await svc.logout(req.body.refreshToken);
  ok(res, null);
});

authRoutes.get("/me", auth, async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: req.user!.id },
    omit: { passwordHash: true },
  });
  const m = await svc.activeMembership(user.id);
  ok(res, {
    ...user,
    role: m?.role.key,
    roleName: m?.role.name,
    position: m?.position,
    division: m?.division ? { id: m.division.id, name: m.division.name } : null,
    period: m?.period ? { id: m.period.id, name: m.period.name } : null,
    permissions: [...req.user!.permissions],
    divisionGrants: [...req.user!.divisionGrants],
    memberQr: memberToken(user.id), // QR personal untuk mode scan balik
  });
});

// Anggota hanya boleh ubah data diri terbatas (PRD bagian 11); email, NIM, jabatan lewat Sekretaris.
authRoutes.patch("/me", auth, validate(updateMeSchema), async (req, res) => {
  // Foto profil & latar harus gambar publik yang diupload user ini sendiri, bukan URL sembarang.
  for (const field of ["avatarUrl", "coverUrl"] as const) {
    if (!req.body[field]) continue;
    const up = await prisma.upload.findUnique({ where: { key: String(req.body[field]).replace(/^\/storage\//, "") } });
    if (!up || up.ownerId !== req.user!.id || up.isPrivate) throw new AppError("VALIDATION", 400, field === "avatarUrl" ? "Foto profil tidak valid" : "Foto latar tidak valid");
  }
  ok(res, await prisma.user.update({ where: { id: req.user!.id }, data: req.body, omit: { passwordHash: true } }));
});

authRoutes.post("/auth/change-password", auth, validate(changePasswordSchema), async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
  if (!(await bcrypt.compare(req.body.currentPassword, user.passwordHash))) throw new AppError("INVALID_CREDENTIALS", 400, "Password lama salah");
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(req.body.newPassword, 10) } }),
    // Cabut semua sesi; perangkat ini langsung dapat token baru.
    prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  await audit(req, "user.change_password", "User", user.id);
  ok(res, await svc.issueTokens(user.id, "web"));
});
