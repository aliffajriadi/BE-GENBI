import { z } from "zod";
import { ROLES } from "./rbac.js";

// ───────────── Schema request ─────────────

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
  device: z.string().max(200).optional(),
});

export const refreshSchema = z.object({ refreshToken: z.string().min(10) });

export const createUserSchema = z.object({
  email: z.email(),
  name: z.string().min(2),
  password: z.string().min(8),
  nim: z.string().max(100).nullish(),
  phone: z.string().max(100).nullish(),
  campus: z.string().max(100).nullish(),
  major: z.string().max(100).nullish(),
  batch: z.string().max(100).nullish(),
  roleKey: z.enum(ROLES),
  divisionId: z.string().nullish(),
  position: z.string().optional(),
});

export const updateUserSchema = createUserSchema.omit({ password: true }).partial().extend({
  status: z.enum(["ACTIVE", "INACTIVE", "ALUMNI"]).optional(),
  resetDevice: z.boolean().optional(),
});

export const createDivisionSchema = z.object({
  name: z.string().min(2),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string().optional(),
});

export const createPeriodSchema = z.object({
  name: z.string().min(4),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
});

export type LoginInput = z.infer<typeof loginSchema>;

// ───────────── Profil sendiri ─────────────

// "@nama", "nama", atau "https://instagram.com/nama/" → "nama". Kosong → null.
const handle = (max: number) =>
  z
    .string()
    .trim()
    .transform((v) => v.replace(/^https?:\/\/(www\.)?[^/]+\/@?/i, "").replace(/^@/, "").replace(/[/?#].*$/, ""))
    .pipe(z.string().max(max).regex(/^[A-Za-z0-9._]*$/, "Username hanya huruf, angka, titik, dan garis bawah"))
    .transform((v) => v || null);

// LinkedIn: simpan slug dari linkedin.com/in/<slug> (huruf, angka, tanda hubung).
const linkedin = z
  .string()
  .trim()
  .transform((v) => v.replace(/^(https?:\/\/)?([a-z]{2,3}\.)?(www\.)?linkedin\.com\/in\//i, "").replace(/^@/, "").replace(/[/?#].*$/, ""))
  .pipe(z.string().max(100).regex(/^([A-Za-z0-9-]{3,100})?$/, "Isi username LinkedIn (bagian setelah linkedin.com/in/)"))
  .transform((v) => v || null);

export const updateMeSchema = z.object({
  name: z.string().min(2).optional(),
  phone: z.string().max(30).nullish(),
  campus: z.string().max(100).nullish(),
  major: z.string().max(100).nullish(),
  batch: z.string().max(10).nullish(),
  avatarUrl: z.string().max(300).nullish(), // URL dari POST /uploads (public=true); null = hapus foto
  coverUrl: z.string().max(300).nullish(), // latar profil, aturan sama dengan avatarUrl
  bio: z.string().trim().max(300).nullish(),
  // Username saja; "@" dan URL lengkap dibuang supaya tautan selalu dibuat server-side ke domain resmi.
  instagram: handle(30).nullish(),
  tiktok: handle(24).nullish(),
  linkedin: linkedin.nullish(),
  website: z.url({ protocol: /^https?$/, message: "Website harus diawali http:// atau https://" }).max(200).nullish(),
  profilePublic: z.boolean().optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, "Password baru minimal 8 karakter"),
});

export const updateDivisionSchema = z.object({
  name: z.string().min(2).optional(),
  description: z.string().nullish(),
});
