import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { cache } from "../../lib/cache.js";
import { prisma } from "../../lib/prisma.js";

// Instagram API with Instagram Login: akun harus Professional (Bisnis/Kreator).
// Token long-lived (60 hari) disimpan di tabel Page (slug "instagram"), tidak pernah dikirim ke klien.
const SLUG = "instagram";
const APP_SLUG = "instagram-app";
const GRAPH = "https://graph.instagram.com";
const CACHE_KEY = "ig:feed";

// Rahasia (app secret & token) disimpan terenkripsi AES-256-GCM; kuncinya diturunkan dari JWT_SECRET.
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

// ─── Aplikasi Meta: diisi admin di web (Pengaturan → Instagram); .env hanya cadangan ───
type AppStored = { appId: string; appSecret: string; redirectUri?: string };
async function appStored() {
  return ((await prisma.page.findFirst({ where: { slug: APP_SLUG } }))?.contentJson as AppStored | null | undefined) ?? null;
}
export async function app() {
  const a = await appStored();
  if (a?.appId && a.appSecret) return { appId: a.appId, appSecret: unseal(a.appSecret), redirectUri: a.redirectUri };
  if (env.IG_APP_ID && env.IG_APP_SECRET) return { appId: env.IG_APP_ID, appSecret: env.IG_APP_SECRET, redirectUri: a?.redirectUri };
  return null;
}
/** appSecret kosong = pakai secret yang sudah tersimpan. */
export async function saveApp(appId: string, appSecret?: string) {
  const prev = await appStored();
  const secret = appSecret ? seal(appSecret) : prev?.appSecret;
  if (!secret) throw new Error("App secret wajib diisi");
  const data = { appId, appSecret: secret, redirectUri: prev?.redirectUri };
  await prisma.page.upsert({ where: { slug: APP_SLUG }, update: { contentJson: data }, create: { slug: APP_SLUG, title: "Aplikasi Instagram", contentJson: data } });
}
async function rememberRedirect(uri: string) {
  const prev = await appStored();
  const data = { appId: prev?.appId ?? "", appSecret: prev?.appSecret ?? "", redirectUri: uri };
  await prisma.page.upsert({ where: { slug: APP_SLUG }, update: { contentJson: data }, create: { slug: APP_SLUG, title: "Aplikasi Instagram", contentJson: data } });
}
export async function appInfo() {
  const a = await appStored();
  return { appId: a?.appId || env.IG_APP_ID || "", hasSecret: !!(a?.appSecret || env.IG_APP_SECRET) };
}

/** URI callback = alamat backend yang dipakai admin (lewat proxy web maupun domain API), atau API_PUBLIC_URL bila diisi. */
export const redirectFor = (origin: string) => `${(env.API_PUBLIC_URL ?? origin).replace(/\/$/, "")}/api/v1/instagram/callback`;

type Stored = { token: string; expiresAt: string; userId: string; username: string; connectedAt: string };

export async function stored(): Promise<Stored | null> {
  const s = (await prisma.page.findFirst({ where: { slug: SLUG, deletedAt: null } }))?.contentJson as Stored | null | undefined;
  return s ? { ...s, token: unseal(s.token) } : null;
}
async function save(s: Stored | null) {
  cache.del(CACHE_KEY);
  if (!s) return prisma.page.deleteMany({ where: { slug: SLUG } });
  const data = { ...s, token: seal(s.token) };
  return prisma.page.upsert({ where: { slug: SLUG }, update: { contentJson: data, deletedAt: null }, create: { slug: SLUG, title: "Instagram", contentJson: data } });
}

async function ig<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message?: string }; error_message?: string };
  if (!r.ok || j.error) throw new Error(j.error?.message ?? j.error_message ?? `Instagram HTTP ${r.status}`);
  return j;
}

// ─── state OAuth: id admin + kedaluwarsa, ditandatangani (callback bersifat publik) ───
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

/** URL izin Instagram; URI callback diingat supaya penukaran code memakai URI yang sama persis. */
export async function authorizeUrl(state: string, redirectUri: string) {
  const a = await app();
  if (!a) throw new Error("Aplikasi Meta belum diatur");
  await rememberRedirect(redirectUri);
  return `https://www.instagram.com/oauth/authorize?${new URLSearchParams({ client_id: a.appId, redirect_uri: redirectUri, response_type: "code", scope: "instagram_business_basic", state })}`;
}

/** Tukar code → token pendek → token 60 hari, lalu simpan. */
export async function connect(code: string) {
  const a = await app();
  if (!a?.redirectUri) throw new Error("Aplikasi Meta belum diatur");
  const short = await ig<{ access_token: string }>("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    body: new URLSearchParams({ client_id: a.appId, client_secret: a.appSecret, grant_type: "authorization_code", redirect_uri: a.redirectUri, code }),
  });
  const long = await ig<{ access_token: string; expires_in: number }>(`${GRAPH}/access_token?${new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: a.appSecret, access_token: short.access_token })}`);
  const me = await ig<{ user_id?: string; id: string; username: string }>(`${GRAPH}/me?fields=user_id,username&access_token=${long.access_token}`);
  const s: Stored = { token: long.access_token, expiresAt: new Date(Date.now() + long.expires_in * 1000).toISOString(), userId: me.user_id ?? me.id, username: me.username, connectedAt: new Date().toISOString() };
  await save(s);
  return s;
}

export const disconnect = () => save(null);

/** Dipanggil job harian: perpanjang token bila sisa < 15 hari (refresh mereset masa 60 hari). */
export async function refreshIfNeeded(now = Date.now()) {
  const s = await stored();
  if (!s || new Date(s.expiresAt).getTime() - now > 15 * 86_400_000) return false;
  const r = await ig<{ access_token: string; expires_in: number }>(`${GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${s.token}`);
  await save({ ...s, token: r.access_token, expiresAt: new Date(now + r.expires_in * 1000).toISOString() });
  return true;
}

export type Feed = {
  profile: { username: string; name?: string; biography?: string; profilePicture?: string; followers: number; following: number; posts: number; url: string };
  media: { id: string; type: string; image: string; caption?: string; permalink: string; timestamp: string; likes?: number; comments?: number }[];
};

/** Profil + 12 postingan terbaru untuk landing page. Di-cache 30 menit supaya tidak kena rate limit. */
export async function feed(): Promise<Feed | null> {
  const hit = cache.get<Feed | null>(CACHE_KEY);
  if (hit !== undefined) return hit;
  const s = await stored();
  if (!s) return null;
  try {
    const t = `access_token=${s.token}`;
    const [p, m] = await Promise.all([
      ig<{ username: string; name?: string; biography?: string; profile_picture_url?: string; followers_count?: number; follows_count?: number; media_count?: number }>(
        `${GRAPH}/me?fields=username,name,biography,profile_picture_url,followers_count,follows_count,media_count&${t}`,
      ),
      ig<{ data: { id: string; media_type: string; media_url?: string; thumbnail_url?: string; caption?: string; permalink: string; timestamp: string; like_count?: number; comments_count?: number }[] }>(
        `${GRAPH}/me/media?fields=id,media_type,media_url,thumbnail_url,caption,permalink,timestamp,like_count,comments_count&limit=12&${t}`,
      ),
    ]);
    const data: Feed = {
      profile: { username: p.username, name: p.name, biography: p.biography, profilePicture: p.profile_picture_url, followers: p.followers_count ?? 0, following: p.follows_count ?? 0, posts: p.media_count ?? 0, url: `https://www.instagram.com/${p.username}/` },
      media: m.data
        .map((x) => ({ id: x.id, type: x.media_type, image: (x.media_type === "VIDEO" ? x.thumbnail_url : x.media_url) ?? "", caption: x.caption, permalink: x.permalink, timestamp: x.timestamp, likes: x.like_count, comments: x.comments_count }))
        .filter((x) => x.image),
    };
    cache.set(CACHE_KEY, data, 1800);
    return data;
  } catch (err) {
    console.error("instagram feed gagal", err);
    cache.set(CACHE_KEY, null, 300); // jangan membanjiri API saat token bermasalah
    return null;
  }
}
