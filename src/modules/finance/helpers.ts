import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../utils/app-error.js";
import { treasuryOf, type Treasury } from "./treasury.js";

export const id = (v: unknown) => String(v);
export const rupiah = (n: number) => `Rp${n.toLocaleString("id-ID")}`;
export const kasOf = (q: { kas?: unknown }) => treasuryOf(q.kas);
export const kasLink = (t: Treasury, tab: string) => `/dashboard/finance?tab=${tab}${t ? `&kas=${t}` : ""}`;

// Upload harus milik user sendiri; mengembalikan URL privat untuk disimpan.
export async function ownUpload(uploadId: string, userId: string) {
  const u = await prisma.upload.findUnique({ where: { id: uploadId } });
  if (!u || u.ownerId !== userId) throw new AppError("VALIDATION", 400, "File bukti tidak valid");
  return `/files/${u.id}`;
}
