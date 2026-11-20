import { z } from "zod";

// ───────────── Planning divisi (kanban) ─────────────
export const boardColumnSchema = z.object({ name: z.string().trim().min(1, "Nama kolom wajib diisi").max(40) });
export const updateColumnSchema = z.object({ name: z.string().trim().min(1).max(40).optional(), isDone: z.boolean().optional(), position: z.number().int().min(0).optional() });
const checklistItem = z.object({ id: z.string().min(1).max(40), text: z.string().trim().min(1).max(200), done: z.boolean() });
export const boardCardSchema = z.object({
  columnId: z.string().min(1),
  title: z.string().trim().min(1, "Judul kartu wajib diisi").max(200),
  description: z.string().max(5000).nullish(),
  assigneeIds: z.array(z.string().min(1)).max(10, "Maksimal 10 PIC").optional(), // PIC bisa lebih dari satu
  dueDate: z.coerce.date().nullish(),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional(),
});
export const updateCardSchema = boardCardSchema.omit({ columnId: true }).partial().extend({ checklist: z.array(checklistItem).max(50).optional() });
export const moveCardSchema = z.object({ columnId: z.string().min(1), index: z.number().int().min(0) });
// Catatan/link divisi. URL wajib http(s) supaya tidak bisa diisi javascript: dsb.
export const httpUrl = z.string().trim().url("Link tidak valid").max(1000).refine((u) => /^https?:\/\//i.test(u), "Link harus diawali http:// atau https://");
export const boardNoteSchema = z.object({
  title: z.string().trim().min(1, "Judul wajib diisi").max(120),
  url: z.union([httpUrl, z.literal("")]).nullish().transform((v) => v || null),
  body: z.string().max(2000).nullish().transform((v) => v || null),
  pinned: z.boolean().optional(),
});
export const updateBoardNoteSchema = boardNoteSchema.partial();
export const boardCommentSchema = z.object({ body: z.string().trim().min(1, "Komentar kosong").max(2000) });
