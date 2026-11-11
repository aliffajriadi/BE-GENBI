import type { Server } from "socket.io";
import { prisma, type Channel, type Prisma } from "../../lib/prisma.js";
import type { AuthUser } from "../../middlewares/auth.js";
import { GLOBAL_ROLES } from "../../shared/index.js";

// Socket.IO server, di-set dari server.ts. Route REST memakai ini untuk menyiarkan pesan & perubahan channel.
let io: Server | null = null;
export const setIo = (s: Server) => { io = s; };
export const room = (channelId: string) => `ch:${channelId}`;
export const broadcast = (channelId: string, event: string, payload: unknown) => io?.to(room(channelId)).emit(event, payload);

// Daftar channel berubah (dibuat/diubah/diarsip): masukkan/keluarkan socket dari room, lalu minta klien memuat ulang daftar.
export async function syncChannelRooms(channelId: string) {
  if (!io) return;
  const c = await prisma.channel.findUnique({ where: { id: channelId }, include: { members: { where: { isMember: true }, select: { userId: true } } } });
  for (const s of await io.fetchSockets()) {
    const u = s.data.user as AuthUser | undefined;
    if (!u) continue;
    const ok = !!c && canAccess(u, c, c.members.some((m) => m.userId === u.id));
    if (ok) s.join(room(channelId));
    else s.leave(room(channelId));
    s.emit("channels:changed");
  }
}

const CORE_ROLES = ["SYS_ADMIN", "KETUM", "SEKRETARIS", "BENDAHARA", "KADIV"];
type ChannelLike = Pick<Channel, "type" | "divisionId" | "key" | "createdById" | "archivedAt">;

// Pengurus inti (Ketum, Sekretaris, admin): kelola semua channel.
export const isGlobalManager = (u: AuthUser) => u.permissions.has("chat.moderate") && GLOBAL_ROLES.includes(u.role);
// Kadiv: hanya channel yang lingkupnya divisi dia sendiri.
// Kadiv, atau anggota yang diberi akses "chat" oleh Kadiv: hanya channel berlingkup divisinya.
const isDivisionManager = (u: AuthUser, c: Pick<Channel, "divisionId">) => u.permissions.has("chat.moderate") && !GLOBAL_ROLES.includes(u.role) && !!u.divisionId && c.divisionId === u.divisionId;
export const canCreateChannels = (u: AuthUser) => isGlobalManager(u) || (u.permissions.has("chat.moderate") && !!u.divisionId);

export const canManage = (u: AuthUser, c: ChannelLike) => isGlobalManager(u) || isDivisionManager(u, c) || (c.key === null && c.createdById === u.id);

export function canAccess(u: AuthUser, c: ChannelLike, isMember: boolean) {
  if (c.archivedAt) return false;
  if (c.type === "GENERAL") return true;
  if (c.type === "CORE") return CORE_ROLES.includes(u.role);
  if (c.type === "DIVISION") return (!!u.divisionId && c.divisionId === u.divisionId) || isGlobalManager(u);
  if (c.type === "CUSTOM") return isMember || canManage(u, c);
  return false;
}

// Channel "pengumuman" (readOnly): semua bisa membaca, hanya pengelola yang bisa menulis.
export const canPost = (u: AuthUser, c: ChannelLike & Pick<Channel, "readOnly">) => !c.readOnly || canManage(u, c);

// Channel bawaan: #umum, #pengurus-inti, dan satu per divisi periode aktif. Aman dipanggil berulang (key unik).
// Banyak socket tersambung bersamaan (mis. saat server restart) dulu memicu INSERT paralel yang deadlock di MySQL;
// sekarang semua pemanggil berbagi satu proses, hanya channel yang belum ada yang dibuat, dan hasilnya diingat 60 detik.
let ensuring: Promise<void> | null = null;
let ensuredAt = 0;
// Dipanggil saat divisi/periode berubah supaya channel divisi baru langsung dibuat, tidak menunggu 60 detik.
export const channelsChanged = () => { ensuredAt = 0; };

export function ensureChannels(): Promise<void> {
  if (Date.now() - ensuredAt < 60_000) return Promise.resolve();
  ensuring ??= (async () => {
    const period = await prisma.period.findFirst({ where: { isActive: true }, include: { divisions: true } });
    const wanted: Prisma.ChannelCreateManyInput[] = [
      { key: "umum", name: "umum", type: "GENERAL" },
      { key: "pengurus-inti", name: "pengurus-inti", type: "CORE" },
      ...(period?.divisions ?? []).map((d) => ({ key: `div:${d.id}`, name: d.slug, type: "DIVISION" as const, divisionId: d.id })),
    ];
    const existing = new Set((await prisma.channel.findMany({ where: { key: { in: wanted.map((w) => w.key!) } }, select: { key: true } })).map((c) => c.key));
    const missing = wanted.filter((w) => !existing.has(w.key!));
    if (missing.length) await prisma.channel.createMany({ data: missing, skipDuplicates: true });
    ensuredAt = Date.now();
  })().finally(() => {
    ensuring = null;
  });
  return ensuring;
}

export async function accessibleChannels(u: AuthUser) {
  await ensureChannels();
  const all = await prisma.channel.findMany({
    where: { archivedAt: null, type: { not: "EVENT" }, OR: [{ divisionId: null }, { division: { period: { isActive: true } } }] },
    include: { division: { select: { name: true } }, members: { where: { userId: u.id }, select: { isMember: true } } },
  });
  // Urutan: bawaan dulu (umum, pengurus-inti, divisi), lalu buatan pengurus menurut nama.
  const rank = (c: (typeof all)[number]) => (c.key === "umum" ? 0 : c.key === "pengurus-inti" ? 1 : c.key ? 2 : 3);
  return all.filter((c) => canAccess(u, c, !!c.members[0]?.isMember)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

// Ambil channel + cek akses untuk satu user (dipakai route REST).
export async function channelFor(u: AuthUser, id: string) {
  const c = await prisma.channel.findUnique({ where: { id }, include: { members: { where: { userId: u.id }, select: { isMember: true } } } });
  if (!c || !canAccess(u, c, !!c.members[0]?.isMember)) return null;
  return c;
}

export const messageInclude = {
  sender: { select: { id: true, name: true, avatarUrl: true } },
  replyTo: { select: { id: true, body: true, deletedAt: true, sender: { select: { name: true } } } },
} as const;

type Row = Prisma.MessageGetPayload<{ include: typeof messageInclude }>;

// Bentuk pesan untuk klien; isi pesan yang dihapus tidak pernah dikirim.
export const toDto = (m: Row) => ({
  id: m.id,
  channelId: m.channelId,
  body: m.deletedAt ? null : m.body,
  deleted: !!m.deletedAt,
  pinned: m.pinned,
  editedAt: m.editedAt,
  createdAt: m.createdAt,
  sender: m.sender,
  replyTo: m.replyTo && { id: m.replyTo.id, senderName: m.replyTo.sender.name, body: m.replyTo.deletedAt ? null : m.replyTo.body.slice(0, 140) },
});
