import { z } from "zod";
import { slugField } from "./links.js";
import { formQuestion } from "./forms.js";

// ───────────── Slot (/s/<slug>): kelompok, undangan/RSVP, sesi, dll. ─────────────
const slotGroup = z.object({
  id: z.string().max(40).optional(), // ada = pilihan lama (diubah), kosong = pilihan baru
  name: z.string().trim().min(1, "Nama pilihan wajib diisi").max(80),
  description: z.string().trim().max(200).nullish(),
  capacity: z.number().int().min(1, "Kuota minimal 1").max(5000).nullish(), // kosong = tanpa batas
});
const slotListFields = {
  slug: slugField,
  title: z.string().trim().min(1, "Judul wajib diisi").max(200),
  description: z.string().max(3000).nullish(),
  optionNoun: z.string().trim().min(1).max(30).optional(),
  joinLabel: z.string().trim().min(1).max(30).optional(),
  questions: z.array(formQuestion).max(20).refine((qs) => new Set(qs.map((q) => q.id)).size === qs.length, "ID pertanyaan dobel").optional(),
  isOpen: z.boolean().optional(),
  closesAt: z.coerce.date().nullish(),
  groups: z.array(slotGroup).min(1, "Minimal 1 pilihan").max(50),
};
export const slotListSchema = z.object(slotListFields);
export const updateSlotListSchema = z.object(slotListFields).partial();
export const slotJoinSchema = z.object({
  groupId: z.string().min(1),
  answers: z.record(z.string(), z.union([z.string().max(5000), z.array(z.string().max(200)).max(50)])).default({}),
});
