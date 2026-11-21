import { z } from "zod";

// ───────────── Tampilan web publik ─────────────

export const siteSchema = z.object({
  heroImage: z.string().max(300).nullable(), // URL dari POST /uploads (public=true); null = tanpa foto
  heroAlt: z.string().max(200).optional(),
  headline: z.string().min(3).max(120),
  subheadline: z.string().max(300).optional(),
});
export type SiteContent = z.infer<typeof siteSchema>;

// Foto panel kanan halaman login (desktop), diatur System Administrator.
export const loginPageSchema = z.object({
  image: z.string().max(300).nullable(), // URL dari POST /uploads (public=true); null = panel biru polos
  alt: z.string().max(200).optional(),
  title: z.string().max(120).optional(), // judul besar di atas foto; kosong = tanpa judul
  caption: z.string().max(240).optional(),
});
export type LoginPage = z.infer<typeof loginPageSchema>;

// Kontak organisasi di footer & ajakan sponsorship, diatur Sekretaris (article.publish). Kosong = tidak ditampilkan.
const link = z.union([z.literal(""), z.string().trim().url("Link tidak valid").regex(/^https:\/\//, "Link harus diawali https://").max(300)]);
export const contactsSchema = z.object({
  email: z.union([z.literal(""), z.string().trim().email("Email tidak valid").max(120)]),
  whatsapp: z.union([z.literal(""), z.string().trim().regex(/^\+?[0-9 -]{8,20}$/, "Nomor WhatsApp tidak valid")]),
  instagram: link,
  youtube: link,
  tiktok: link,
  linkedin: link,
  address: z.string().trim().max(300),
});
export type Contacts = z.infer<typeof contactsSchema>;

// Versi aplikasi mobile: di bawah minVersion = wajib update (app diblokir); di bawah latestVersion = disarankan.
const semver = z.string().regex(/^\d+\.\d+\.\d+$/, "Format versi: 1.2.3");
export const appVersionSchema = z
  .object({
    minVersion: semver,
    latestVersion: semver,
    // Kosong = belum ada file untuk diunduh.
    url: z.union([z.literal(""), z.string().url("Link unduhan tidak valid").regex(/^https?:\/\//, "Link harus http(s)").max(500)]),
    message: z.string().max(300).optional(),
  })
  .refine((v) => compareVersion(v.minVersion, v.latestVersion) <= 0, { message: "Versi minimal tidak boleh lebih baru dari versi terbaru", path: ["minVersion"] });
export type AppVersion = z.infer<typeof appVersionSchema>;

// Panduan unduh ("artikel mini" di menu Unduh aplikasi), dikelola System Administrator.
export const downloadGuideSchema = z.object({
  title: z.string().trim().min(3).max(120),
  platform: z.enum(["ANDROID", "IOS", "WEB", "OTHER"]),
  url: z.union([z.literal(""), z.string().url("Link tidak valid").regex(/^https?:\/\//, "Link harus http(s)").max(500)]),
  buttonLabel: z.string().trim().max(40).optional(),
  body: z.string().max(20000),
  order: z.number().int().min(0).max(999).default(0),
});
export type DownloadGuide = z.infer<typeof downloadGuideSchema>;

/** -1 / 0 / 1 untuk versi "x.y.z". */
export function compareVersion(a: string, b: string) {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  return 0;
}
