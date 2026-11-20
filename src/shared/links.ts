import { z } from "zod";
import { httpUrl } from "./planning.js";

// ───────────── Shortlink (/l/<slug>) ─────────────
export const slugField = z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/, "Slug hanya huruf kecil, angka, dan tanda - (maks 60)");
export const shortLinkSchema = z.object({
  slug: slugField,
  url: httpUrl,
  title: z.string().trim().min(1, "Judul wajib diisi").max(120),
  active: z.boolean().optional(),
});
export const updateShortLinkSchema = shortLinkSchema.partial();
