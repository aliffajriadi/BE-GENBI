import { ipKeyGenerator, rateLimit } from "express-rate-limit";

// 5 percobaan login/menit per IP + email (PRD bagian 15).
export const loginLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  // ipKeyGenerator mengelompokkan IPv6 per subnet supaya batas tidak bisa diakali dengan ganti alamat.
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? "")}:${String(req.body?.email ?? "").toLowerCase()}`,
  handler: (_req, res) =>
    res.status(429).json({ success: false, error: { code: "RATE_LIMITED", message: "Terlalu banyak percobaan, coba lagi 1 menit" } }),
});

// Kirim form publik: cukup longgar untuk satu WiFi kampus, cukup ketat untuk menahan spam.
export const formLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: 30,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
  handler: (_req, res) => res.status(429).json({ success: false, error: { code: "RATE_LIMITED", message: "Terlalu banyak kiriman, coba lagi beberapa menit lagi" } }),
});

// Per akun, bukan per IP: satu ruangan rapat biasanya satu WiFi (satu IP publik), jangan sampai peserta ke-31 ditolak.
export const scanLimiter = rateLimit({ windowMs: 60_000, limit: 30, keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? "") });
