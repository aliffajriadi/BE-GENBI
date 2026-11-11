import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// Satu pintu ke penyimpanan file (PRD bagian 12). shortcut: disk lokal; ganti isi fungsi ini untuk pindah ke R2/MinIO.
const ROOT = path.resolve(process.env.STORAGE_DIR ?? "storage");

export const MAX_UPLOAD = 2 * 1024 * 1024; // 2 MB per file (foto dikecilkan otomatis di browser sebelum dikirim)

// Cek isi file (magic bytes), bukan cuma ekstensi/mimetype dari klien.
const SIGNATURES: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { mime: "image/jpeg", ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", ext: "png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/webp", ext: "webp", test: (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP" },
  { mime: "application/pdf", ext: "pdf", test: (b) => b.subarray(0, 5).toString() === "%PDF-" },
];

export function sniff(buf: Buffer) {
  return SIGNATURES.find((s) => s.test(buf)) ?? null;
}

export async function save(buf: Buffer, ext: string, isPublic: boolean) {
  const key = `${isPublic ? "public" : "private"}/${crypto.randomUUID()}.${ext}`; // nama acak: tidak bisa ditebak
  const full = path.join(ROOT, key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buf);
  return key;
}

export const fullPath = (key: string) => path.join(ROOT, key);
export const publicDir = path.join(ROOT, "public");
export const remove = (key: string) => fs.rm(path.join(ROOT, key), { force: true });
