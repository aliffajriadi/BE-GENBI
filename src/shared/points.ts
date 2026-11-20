import { z } from "zod";

// ───────────── Poin (PRD bagian 6) ─────────────

export const DEFAULT_POINT_RULES = [
  { key: "HADIR", label: "Hadir rapat", points: 10, trigger: "AUTO" },
  { key: "TELAT", label: "Hadir tapi telat", points: 5, trigger: "AUTO" },
  { key: "IZIN", label: "Izin disetujui", points: 0, trigger: "AUTO" },
  { key: "ALPA", label: "Alpa", points: -5, trigger: "AUTO" },
  { key: "ARTICLE_PUBLISHED", label: "Artikel dipublish", points: 15, trigger: "AUTO" },
  { key: "KAS_ON_TIME", label: "Bayar kas tepat waktu", points: 5, trigger: "AUTO" },
  { key: "PANITIA", label: "Jadi panitia kegiatan", points: 30, trigger: "MANUAL" },
  { key: "KONTRIBUSI", label: "Kontribusi lain", points: 0, trigger: "MANUAL" },
] as const;

export const adjustPointsSchema = z.object({
  userId: z.string(),
  points: z.number().int().refine((n) => n !== 0, "Poin tidak boleh 0"),
  ruleKey: z.string().optional(),
  note: z.string().min(3),
});

export const pointRuleSchema = z.object({
  key: z.string().regex(/^[A-Z0-9_]+$/),
  label: z.string().min(2),
  points: z.number().int(),
  trigger: z.enum(["AUTO", "MANUAL"]),
  isActive: z.boolean().default(true),
});
