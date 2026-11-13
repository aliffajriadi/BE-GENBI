import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";

// Instagram API with Unified Login (graph.facebook.com).
// Admin login lewat facebook.com/dialog/oauth dengan config_id → token system-user (SUAT) milik business portfolio.
// Token & app secret disimpan terenkripsi di tabel Page; feed disimpan di Page juga, dan klien hanya membaca feed itu.
const GRAPH = "https://graph.facebook.com/v27.0";
const APP_SLUG = "instagram-app";
const TOKEN_SLUG = "instagram";
const FEED_SLUG = "instagram-feed";

// ─── Enkripsi rahasia: AES-256-GCM, kunci diturunkan dari JWT_SECRET ───
const KEY = crypto.createHash("sha256").update(`ig-store:${env.JWT_SECRET}`).digest();
export function seal(text: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const data = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}
export function unseal(sealed: string) {
  const [iv, tag, data] = sealed.split(".").map((x) => Buffer.from(x, "base64url"));
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}

const read = async <T>(slug: string) => ((await prisma.page.findFirst({ where: { slug, deletedAt: null } }))?.contentJson as T | null | undefined) ?? null;
const write = (slug: string, title: string, data: object) =>
  prisma.page.upsert({ where: { slug }, update: { contentJson: data, deletedAt: null }, create: { slug, title, contentJson: data } });

// ─── Aplikasi Meta (diisi admin di web): App ID & App Secret dari Settings > Basic, Config ID dari Facebook Login for Business ───
type AppStored = { appId: string; appSecret: string; configId: string; redirectUri?: string };
export async function app() {
  const a = await read<AppStored>(APP_SLUG);
  return a?.appId && a.appSecret && a.configId ? { ...a, appSecret: unseal(a.appSecret) } : null;
}
/** appSecret kosong = pakai secret yang sudah tersimpan. */
export async function saveApp(input: { appId: string; appSecret?: string; configId: string }) {
  const prev = await read<AppStored>(APP_SLUG);
  const secret = input.appSecret ? seal(input.appSecret) : prev?.appSecret;
  if (!secret) throw new Error("App Secret wajib diisi");
  await write(APP_SLUG, "Aplikasi Meta Instagram", { appId: input.appId, appSecret: secret, configId: input.configId, redirectUri: prev?.redirectUri });
}
export async function appInfo() {
  const a = await read<AppStored>(APP_SLUG);
  return { appId: a?.appId ?? "", configId: a?.configId ?? "", hasSecret: !!a?.appSecret };
}

/** URI callback = alamat backend yang dipakai admin (trust proxy), atau API_PUBLIC_URL bila diisi. */
export const redirectFor = (origin: string) => `${(env.API_PUBLIC_URL ?? origin).replace(/\/$/, "")}/api/v1/instagram/callback`;

// Token verifikasi webhook (Meta mewajibkan endpoint webhook https saat setup; kita tidak memakai isinya).
export const webhookVerifyToken = () => crypto.createHmac("sha256", env.JWT_SECRET).update("ig-webhook").digest("hex").slice(0, 32);

// ─── state OAuth anti-CSRF: id admin + kedaluwarsa, ditandatangani (callback bersifat publik) ───
const sign = (v: string) => crypto.createHmac("sha256", env.JWT_SECRET).update(`ig:${v}`).digest("base64url");
export function makeState(userId: string) {
  const v = `${userId}.${Date.now() + 10 * 60_000}`;
  return `${v}.${sign(v)}`;
}
export function readState(state: string) {
  const i = state.lastIndexOf(".");
  if (i < 0) return null;
  const v = state.slice(0, i), mac = Buffer.from(state.slice(i + 1)), want = Buffer.from(sign(v));
  const [userId, exp] = v.split(".");
  return mac.length === want.length && crypto.timingSafeEqual(mac, want) && Number(exp) > Date.now() ? userId : null;
}

/** URL login Unified Login (tanpa scope: izin ditentukan config_id). URI callback diingat untuk penukaran code. */
export async function authorizeUrl(state: string, redirectUri: string) {
  const a = await app();
  if (!a) throw new Error("Aplikasi Meta belum diatur");
  await write(APP_SLUG, "Aplikasi Meta Instagram", { ...a, appSecret: seal(a.appSecret), redirectUri });
  return loginUrl(a, redirectUri, state);
}
export const loginUrl = (a: { appId: string; configId: string }, redirectUri: string, state: string) =>
  `https://www.facebook.com/dialog/oauth?${new URLSearchParams({ client_id: a.appId, config_id: a.configId, redirect_uri: redirectUri, response_type: "code", override_default_response_type: "true", state })}`;

async function graph<T>(path: string, token: string | null, params: Record<string, string> = {}): Promise<T> {
  const q = new URLSearchParams(token ? { ...params, access_token: token } : params);
  const r = await fetch(`${GRAPH}${path}?${q}`, { signal: AbortSignal.timeout(10_000) });
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!r.ok || j.error) throw new Error(j.error?.message ?? `Graph HTTP ${r.status}`);
  return j;
}

type TokenStored = { token: string; igUserId: string; username: string; connectedAt: string; expiresAt: string | null };
export async function stored(): Promise<TokenStored | null> {
  const s = await read<TokenStored>(TOKEN_SLUG);
  return s ? { ...s, token: unseal(s.token) } : null;
}

/** Tukar code → token system-user, cari akun Instagram yang dibagikan, lalu langsung isi feed. */
export async function connect(code: string) {
  const a = await app();
  if (!a?.redirectUri) throw new Error("Aplikasi Meta belum diatur");
  const t = await graph<{ access_token: string; expires_in?: number }>("/oauth/access_token", null, {
    client_id: a.appId,
    client_secret: a.appSecret,
    redirect_uri: a.redirectUri,
    code,
  });
  const accounts = await graph<{ data: { id: string; username: string }[] }>("/me/assigned_instagram_accounts", t.access_token, { fields: "id,username" });
  const acc = accounts.data[0];
  if (!acc) throw new Error("Tidak ada akun Instagram yang dibagikan saat login");
  // expires_in hanya ada bila konfigurasi SUAT memakai masa berlaku; "tidak kedaluwarsa" → null.
  const s: TokenStored = { token: t.access_token, igUserId: acc.id, username: acc.username, connectedAt: new Date().toISOString(), expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null };
  await write(TOKEN_SLUG, "Instagram", { ...s, token: seal(s.token) });
  await refreshFeed().catch((err) => console.error("instagram feed awal gagal", err));
  return s;
}

export async function disconnect() {
  await prisma.page.deleteMany({ where: { slug: { in: [TOKEN_SLUG, FEED_SLUG] } } });
}

export type Feed = {
  fetchedAt: string;
  profile: { username: string; name?: string; biography?: string; profilePicture?: string; followers: number; following: number; posts: number; url: string };
  media: { id: string; type: string; image: string; caption?: string; permalink: string; timestamp: string; likes?: number; comments?: number }[];
};

/** Ambil profil + 12 postingan terbaru lalu simpan ke database. Dipanggil job tiap 30 menit dan setelah login. */
export async function refreshFeed() {
  const s = await stored();
  if (!s) return null;
  const [p, m] = await Promise.all([
    graph<{ username: string; name?: string; biography?: string; profile_picture_url?: string; followers_count?: number; follows_count?: number; media_count?: number }>(`/${s.igUserId}`, s.token, {
      fields: "username,name,biography,profile_picture_url,followers_count,follows_count,media_count",
    }),
    graph<{ data: { id: string; media_type: string; media_url?: string; thumbnail_url?: string; caption?: string; permalink: string; timestamp: string; like_count?: number; comments_count?: number }[] }>(
      `/${s.igUserId}/media`,
      s.token,
      { fields: "id,media_type,media_url,thumbnail_url,caption,permalink,timestamp,like_count,comments_count", limit: "12" },
    ),
  ]);
  const feed: Feed = {
    fetchedAt: new Date().toISOString(),
    profile: { username: p.username, name: p.name, biography: p.biography, profilePicture: p.profile_picture_url, followers: p.followers_count ?? 0, following: p.follows_count ?? 0, posts: p.media_count ?? 0, url: `https://www.instagram.com/${p.username}/` },
    // media_url bisa kosong (mis. reel dengan audio berhak cipta) → pakai thumbnail, buang bila tetap kosong.
    media: m.data
      .map((x) => ({ id: x.id, type: x.media_type, image: (x.media_type === "VIDEO" ? x.thumbnail_url ?? x.media_url : x.media_url ?? x.thumbnail_url) ?? "", caption: x.caption, permalink: x.permalink, timestamp: x.timestamp, likes: x.like_count, comments: x.comments_count }))
      .filter((x) => x.image),
  };
  await write(FEED_SLUG, "Feed Instagram", feed);
  return feed;
}

/** Feed tersimpan (untuk landing page / klien). Tidak memanggil Meta. */
export const feed = () => read<Feed>(FEED_SLUG);
