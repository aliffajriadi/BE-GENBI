import crypto from "node:crypto";
import { env } from "../../config/env.js";

export const QR_ROTATE_MS = 20_000; // QR berganti tiap 20 detik
export const QR_VALID_MS = 30_000; // token ditolak setelah 30 detik

const hmac = (key: string, data: string) => crypto.createHmac("sha256", key).update(data).digest("base64url");
const safeEq = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Token absensi: "<eventId>.<ts>.<sig>". Kunci = QR_SECRET + secret per sesi buka absensi,
// jadi token dari sesi sebelumnya otomatis tidak berlaku.
export function eventToken(eventId: string, sessionSecret: string, now = Date.now()) {
  const ts = Math.floor(now / QR_ROTATE_MS) * QR_ROTATE_MS;
  return { token: `${eventId}.${ts}.${hmac(env.QR_SECRET + sessionSecret, `${eventId}.${ts}`)}`, expiresAt: ts + QR_ROTATE_MS };
}

export function parseEventToken(token: string) {
  const [eventId, ts, sig] = token.split(".");
  if (!eventId || !ts || !sig || !/^\d+$/.test(ts)) return null;
  return { eventId, ts: Number(ts), sig };
}

export function verifyEventToken(token: string, sessionSecret: string, now = Date.now()): "OK" | "INVALID" | "EXPIRED" {
  const p = parseEventToken(token);
  if (!p) return "INVALID";
  if (!safeEq(p.sig, hmac(env.QR_SECRET + sessionSecret, `${p.eventId}.${p.ts}`))) return "INVALID";
  if (now - p.ts > QR_VALID_MS || p.ts > now + 5_000) return "EXPIRED";
  return "OK";
}

// QR personal anggota untuk mode scan balik: "m.<userId>.<sig>".
export const memberToken = (userId: string) => `m.${userId}.${hmac(env.QR_SECRET, `member:${userId}`)}`;

export function verifyMemberToken(token: string): string | null {
  const [m, userId, sig] = token.split(".");
  if (m !== "m" || !userId || !sig) return null;
  return safeEq(sig, hmac(env.QR_SECRET, `member:${userId}`)) ? userId : null;
}

export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
