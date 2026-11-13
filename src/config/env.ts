import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  QR_SECRET: z.string().min(16),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  LETTER_ORG: z.string().default("GenBI"), // kode organisasi di nomor surat keluar
  // Opsional: biasanya diisi admin lewat web (Pengaturan → Instagram). Ini hanya cadangan/override.
  API_PUBLIC_URL: z.string().optional(), // alamat backend dari internet; kosong = diambil dari request
});

export const env = schema.parse(process.env);
