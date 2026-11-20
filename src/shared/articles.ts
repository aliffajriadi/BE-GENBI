import { z } from "zod";

// ───────────── Artikel ─────────────

export const ARTICLE_KINDS = ["NEWS", "PERSONAL"] as const;
export const createArticleSchema = z.object({ title: z.string().min(3), kind: z.enum(ARTICLE_KINDS).default("PERSONAL") });

export const updateArticleSchema = z.object({
  title: z.string().min(3).optional(),
  slug: z.string().regex(/^[a-z0-9-]+$/, "Slug hanya huruf kecil, angka, dan tanda -").optional(),
  excerpt: z.string().max(300).nullish(),
  body: z.string().max(200_000).optional(),
  coverUrl: z.string().nullish(),
  coverAlt: z.string().max(200).nullish(),
  seoTitle: z.string().max(70).nullish(),
  seoDesc: z.string().max(160).nullish(),
  tags: z.array(z.string().min(1).max(30)).max(8).optional(),
  kind: z.enum(ARTICLE_KINDS).optional(),
});

export const publishArticleSchema = z.object({ scheduledAt: z.coerce.date().optional() });
