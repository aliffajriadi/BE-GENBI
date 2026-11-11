import { Router } from "express";
import multer from "multer";
import { prisma } from "../../lib/prisma.js";
import { fullPath, MAX_UPLOAD, save, sniff } from "../../lib/storage.js";
import { auth } from "../../middlewares/auth.js";
import { AppError } from "../../utils/app-error.js";
import { ok } from "../../utils/response.js";

export const uploadsRoutes = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD, files: 1 } });

// File publik (cover artikel) disajikan statis di /storage/public; selain itu privat lewat GET /files/:id.
export const fileUrl = (u: { id: string; key: string; isPrivate: boolean }) => (u.isPrivate ? `/files/${u.id}` : `/storage/${u.key}`);

uploadsRoutes.post("/uploads", auth, (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) return next(new AppError("UPLOAD_INVALID", 400, err.code === "LIMIT_FILE_SIZE" ? "Ukuran file maksimal 5 MB" : "Upload gagal"));
    next();
  });
}, async (req, res) => {
  if (!req.file) throw new AppError("UPLOAD_INVALID", 400, "File wajib diisi");
  const kind = sniff(req.file.buffer);
  if (!kind) throw new AppError("UPLOAD_INVALID", 400, "Format harus JPG, PNG, WEBP, atau PDF");
  const isPublic = req.body?.public === "true";
  // Publik (gambar artikel, foto profil) hanya untuk gambar; dokumen selalu privat.
  if (isPublic && kind.mime === "application/pdf") throw new AppError("FORBIDDEN", 403, "Upload publik hanya untuk gambar");
  // shortcut: metadata EXIF foto belum dibuang; tambahkan sharp().rotate() saat upload foto anggota mulai banyak.
  const key = await save(req.file.buffer, kind.ext, isPublic);
  const u = await prisma.upload.create({ data: { key, mime: kind.mime, size: req.file.size, isPrivate: !isPublic, ownerId: req.user!.id } });
  ok(res, { id: u.id, url: fileUrl(u), mime: u.mime, size: u.size }, undefined, 201);
});

// Siapa boleh unduh file privat: pemilik, atau peran yang mengelola modul pemilik file itu.
uploadsRoutes.get("/files/:id", auth, async (req, res) => {
  const u = await prisma.upload.findUnique({ where: { id: String(req.params.id) } });
  if (!u) throw new AppError("NOT_FOUND", 404, "File tidak ditemukan");
  const me = req.user!;
  const allowed =
    !u.isPrivate ||
    u.ownerId === me.id ||
    (await prisma.bankAccount.count({ where: { qrisImageUrl: `/files/${u.id}` } })) > 0 ||
    (me.permissions.has("finance.read") && (await prisma.payment.count({ where: { proofUrl: `/files/${u.id}` } })) > 0) ||
    (me.permissions.has("finance.read") && (await prisma.cashTransaction.count({ where: { attachmentUrl: `/files/${u.id}` } })) > 0) ||
    (me.permissions.has("leave.decide") && (await prisma.leaveRequest.count({ where: { attachmentUrl: `/files/${u.id}` } })) > 0) ||
    (await canSeeAdminFile(me, u.id));
  if (!allowed) throw new AppError("FORBIDDEN", 403, "Tidak punya akses ke file ini");
  res.setHeader("Content-Type", u.mime);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(fullPath(u.key));
});

async function canSeeAdminFile(me: { permissions: Set<string> }, id: string) {
  const url = `/files/${id}`;
  if ((await prisma.document.count({ where: { fileUrl: url, deletedAt: null, visibility: "SEMUA" } })) > 0) return true;
  if (!me.permissions.has("admin.read")) return false;
  return (await prisma.document.count({ where: { fileUrl: url } })) + (await prisma.letter.count({ where: { fileUrl: url } })) > 0;
}
