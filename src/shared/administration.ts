import { z } from "zod";

// ───────────── Administrasi ─────────────

export const letterSchema = z.object({
  direction: z.enum(["IN", "OUT"]),
  subject: z.string().min(3),
  counterparty: z.string().min(2),
  date: z.coerce.date(),
  number: z.string().max(80).optional(), // surat masuk: nomor dari pengirim; surat keluar: otomatis
  fileId: z.string().optional(),
  status: z.enum(["DRAFT", "SIGNED", "SENT", "RECEIVED", "ARCHIVED"]).optional(),
});
export const updateLetterSchema = letterSchema.omit({ direction: true }).partial();

export const dispositionSchema = z
  .object({ toUserId: z.string().optional(), toDivisionId: z.string().optional(), note: z.string().optional() })
  .refine((d) => d.toUserId || d.toDivisionId, { message: "Pilih tujuan disposisi" });

const actionItemInput = z.object({ title: z.string().min(2), picId: z.string(), dueDate: z.coerce.date().optional() });

export const minuteSchema = z.object({
  eventId: z.string(),
  content: z.string().min(5),
  decisions: z.string().optional(),
  actionItems: z.array(actionItemInput).default([]),
});
export const updateMinuteSchema = z.object({ content: z.string().min(5).optional(), decisions: z.string().optional() });
export const addActionItemSchema = actionItemInput;
export const updateActionItemSchema = z.object({ done: z.boolean() });

export const documentSchema = z.object({
  title: z.string().min(2),
  category: z.string().min(2).max(40),
  fileId: z.string(),
  visibility: z.enum(["PENGURUS", "SEMUA"]).default("PENGURUS"),
});
