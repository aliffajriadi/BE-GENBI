import crypto from "node:crypto";
import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { auth, requirePermission } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import { signatureSchema, updateSignatureSchema } from "../../shared/index.js";
import { AppError } from "../../utils/app-error.js";
import { ok } from "../../utils/response.js";
import { audit } from "../audit/audit.service.js";

// Tanda tangan elektronik berbasis QR. QR berisi <web>/ttd/<code>; siapa pun yang scan melihat penanda tangan & agendanya.
// Hanya pemegang signature.create (default: petinggi) yang bisa membuat; ubah/cabut/hapus hanya oleh penanda tangannya sendiri.
export const signaturesRoutes = Router();

const signer = { select: { name: true, avatarUrl: true } } as const;

async function own(userId: string, id: string) {
  const s = await prisma.signature.findUnique({ where: { id } });
  if (!s || s.signerId !== userId) throw new AppError("NOT_FOUND", 404, "Tanda tangan tidak ditemukan");
  return s;
}

// Publik: dipanggil halaman /ttd/<code>. Kode acak 16 karakter, jadi tidak bisa ditebak dari luar.
signaturesRoutes.get("/public/signatures/:code", async (req, res) => {
  const s = await prisma.signature.findUnique({ where: { code: String(req.params.code) }, include: { signer } });
  if (!s) throw new AppError("NOT_FOUND", 404, "Tanda tangan tidak ditemukan");
  ok(res, { code: s.code, title: s.title, purpose: s.purpose, signerTitle: s.signerTitle, signedAt: s.signedAt, revokedAt: s.revokedAt, signer: s.signer });
});

signaturesRoutes.get("/signatures", auth, requirePermission("signature.create"), async (req, res) => {
  ok(res, await prisma.signature.findMany({ where: { signerId: req.user!.id }, orderBy: { signedAt: "desc" } }));
});

signaturesRoutes.post("/signatures", auth, requirePermission("signature.create"), validate(signatureSchema), async (req, res) => {
  const s = await prisma.signature.create({ data: { ...req.body, code: crypto.randomBytes(12).toString("base64url"), signerId: req.user!.id } });
  await audit(req, "signature.create", "Signature", s.id, null, s);
  ok(res, s, undefined, 201);
});

signaturesRoutes.patch("/signatures/:id", auth, requirePermission("signature.create"), validate(updateSignatureSchema), async (req, res) => {
  const before = await own(req.user!.id, String(req.params.id));
  const { revoked, ...rest } = req.body as { revoked?: boolean };
  const data = revoked === undefined ? rest : { ...rest, revokedAt: revoked ? (before.revokedAt ?? new Date()) : null };
  const s = await prisma.signature.update({ where: { id: before.id }, data });
  await audit(req, revoked === undefined ? "signature.update" : revoked ? "signature.revoke" : "signature.restore", "Signature", s.id, before, s);
  ok(res, s);
});

signaturesRoutes.delete("/signatures/:id", auth, requirePermission("signature.create"), async (req, res) => {
  const s = await own(req.user!.id, String(req.params.id));
  await prisma.signature.delete({ where: { id: s.id } });
  await audit(req, "signature.delete", "Signature", s.id, s, null);
  ok(res, null);
});
