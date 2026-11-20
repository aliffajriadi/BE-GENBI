import { z } from "zod";

// ───────────── Tanda tangan elektronik (/ttd/<code>) ─────────────
export const signatureSchema = z.object({
  title: z.string().trim().min(1, "Agenda wajib diisi").max(150),
  purpose: z.string().trim().max(1000).nullish(),
  signerTitle: z.string().trim().min(1, "Jabatan wajib diisi").max(120),
  signedAt: z.coerce.date().optional(),
});
export const updateSignatureSchema = signatureSchema.partial().extend({ revoked: z.boolean().optional() });
