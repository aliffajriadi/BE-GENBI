import { z } from "zod";

// ───────────── Keuangan ─────────────

export const bankAccountSchema = z.object({
  bankName: z.string().min(2),
  accountNumber: z.string().min(3).max(40),
  accountName: z.string().min(2),
  qrisImageUrl: z.string().nullish(),
  isActive: z.boolean().optional(),
});

export const duesPlanSchema = z
  .object({
    name: z.string().min(2),
    amount: z.number().int().positive(),
    frequency: z.enum(["MONTHLY", "SEMESTER", "ONCE"]),
    dueDay: z.number().int().min(1).max(28).optional(),
    dueDate: z.coerce.date().optional(),
    scope: z.enum(["ALL", "DIVISION"]).default("ALL"),
    divisionId: z.string().nullish(),
  })
  .refine((p) => p.frequency !== "ONCE" || !!p.dueDate, { message: "Iuran sekali bayar butuh tanggal jatuh tempo", path: ["dueDate"] })
  .refine((p) => p.scope !== "DIVISION" || !!p.divisionId, { message: "Pilih divisi", path: ["divisionId"] });

export const updateDuesPlanSchema = z.object({ name: z.string().min(2).optional(), amount: z.number().int().positive().optional(), isActive: z.boolean().optional() });

export const paymentSchema = z.object({
  billIds: z.array(z.string()).min(1, "Pilih minimal satu tagihan"),
  amount: z.number().int().positive(),
  transferDate: z.coerce.date(),
  proofId: z.string().min(1, "Upload bukti transfer"),
});

export const rejectSchema = z.object({ reason: z.string().min(3, "Isi alasan penolakan") });

export const cashTransactionSchema = z.object({
  type: z.enum(["IN", "OUT"]),
  category: z.string().min(2),
  amount: z.number().int().positive(),
  date: z.coerce.date(),
  description: z.string().optional(),
  attachmentId: z.string().optional(),
});
