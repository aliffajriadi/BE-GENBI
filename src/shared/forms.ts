import { z } from "zod";
import { slugField } from "./links.js";

// ───────────── Form (/f/<slug>) ─────────────
export const FORM_QUESTION_TYPES = ["SHORT", "PARAGRAPH", "CHOICE", "CHECKBOX", "DROPDOWN", "DATE", "NUMBER"] as const;
export type FormQuestionType = (typeof FORM_QUESTION_TYPES)[number];
export const OPTION_TYPES: FormQuestionType[] = ["CHOICE", "CHECKBOX", "DROPDOWN"];
export const formQuestion = z
  .object({
    id: z.string().min(1).max(40),
    type: z.enum(FORM_QUESTION_TYPES),
    label: z.string().trim().min(1, "Teks pertanyaan wajib diisi").max(300),
    help: z.string().trim().max(500).nullish(),
    required: z.boolean().default(false),
    options: z.array(z.string().trim().min(1, "Pilihan tidak boleh kosong").max(200)).max(50).optional(),
  })
  .refine((q) => !OPTION_TYPES.includes(q.type) || (q.options?.length ?? 0) > 0, "Pertanyaan pilihan butuh minimal 1 opsi");
export type FormQuestion = z.infer<typeof formQuestion>;
// Tampilan form: classic = ala Google Form (kartu), minimal = ala Tally (polos, tanpa kartu).
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Warna harus format #RRGGBB");
export const formThemeSchema = z.object({
  style: z.enum(["classic", "minimal"]).default("classic"),
  accent: hexColor.default("#11418b"),
  background: hexColor.default("#f1f5f9"),
  font: z.enum(["sans", "serif", "mono"]).default("sans"),
  radius: z.enum(["sharp", "rounded", "pill"]).default("rounded"),
  // Gambar header: hasil upload publik (/storage/…) atau https. Dirender sebagai <img>, bukan CSS.
  coverUrl: z.string().max(500).regex(/^(\/storage\/[\w./-]+|https:\/\/\S+)$/, "Gambar header tidak valid").nullish(),
  showLogo: z.boolean().default(true),
});
const formFields = {
  slug: slugField,
  title: z.string().trim().min(1, "Judul form wajib diisi").max(200),
  description: z.string().max(5000).nullish(),
  audience: z.enum(["PUBLIC", "MEMBERS"]).optional(),
  isOpen: z.boolean().optional(),
  closesAt: z.coerce.date().nullish(),
  onePerUser: z.boolean().optional(),
  theme: formThemeSchema.nullish(),
  questions: z.array(formQuestion).min(1, "Minimal 1 pertanyaan").max(100).refine((qs) => new Set(qs.map((q) => q.id)).size === qs.length, "ID pertanyaan dobel"),
};
export const formSchema = z.object(formFields);
export const updateFormSchema = z.object(formFields).partial();
// `website` = honeypot: tidak terlihat manusia, biasanya diisi bot.
export const formSubmitSchema = z.object({
  answers: z.record(z.string(), z.union([z.string().max(5000), z.array(z.string().max(200)).max(50)])),
  website: z.string().optional(),
});
