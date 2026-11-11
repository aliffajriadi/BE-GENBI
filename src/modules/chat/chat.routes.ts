import { Router } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { z } from "zod";
import { prisma, type Channel } from "../../lib/prisma.js";
import { auth, type AuthUser } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import { AppError } from "../../utils/app-error.js";
import { ok } from "../../utils/response.js";
import { audit } from "../audit/audit.service.js";
import {
  accessibleChannels, broadcast, canAccess, canCreateChannels, canManage, canPost, channelFor as findChannel, isGlobalManager, messageInclude, syncChannelRooms, toDto,
} from "./chat.service.js";

export const chatRoutes = Router();

const bodySchema = z.object({ body: z.string().trim().min(1, "Pesan kosong").max(4000, "Pesan terlalu panjang"), replyToId: z.string().optional() });
// Anti-spam: 20 pesan per 10 detik per orang.
const sendLimiter = rateLimit({ windowMs: 10_000, limit: 20, keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? "") });

const channelSchema = z.object({
  name: z.string().trim().min(2, "Nama minimal 2 karakter").max(40, "Nama maksimal 40 karakter"),
  description: z.string().trim().max(300).nullish(),
  scope: z.enum(["ALL", "DIVISION", "MEMBERS"]), // semua anggota / satu divisi / anggota pilihan
  divisionId: z.string().nullish(),
  memberIds: z.array(z.string()).max(500).default([]),
  readOnly: z.boolean().default(false),
});
const updateChannelSchema = channelSchema.pick({ name: true, description: true, readOnly: true }).partial().extend({ memberIds: z.array(z.string()).max(500).optional() });

async function channelFor(u: AuthUser, id: string) {
  const c = await findChannel(u, id);
  if (!c) throw new AppError("NOT_FOUND", 404, "Channel tidak ditemukan");
  return c;
}

// Anggota yang boleh dimasukkan: aktif di periode berjalan; kalau channel berlingkup divisi, harus anggota divisi itu.
async function validMembers(ids: string[], divisionId: string | null) {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const found = await prisma.membership.findMany({
    where: { userId: { in: unique }, period: { isActive: true }, user: { status: "ACTIVE", deletedAt: null }, ...(divisionId ? { divisionId } : {}) },
    select: { userId: true },
  });
  if (found.length !== unique.length) throw new AppError("VALIDATION", 400, divisionId ? "Ada anggota di luar divisi ini" : "Ada anggota yang tidak aktif");
  return unique;
}

const channelView = (u: AuthUser, c: Channel & { division?: { name: string } | null }) => ({
  id: c.id, name: c.name, description: c.description, type: c.type, readOnly: c.readOnly, system: c.key !== null,
  division: c.division?.name ?? null, divisionId: c.divisionId,
  canManage: canManage(u, c), canPost: canPost(u, c),
});

chatRoutes.get("/channels", auth, async (req, res) => {
  const u = req.user!;
  const channels = await accessibleChannels(u);
  const reads = await prisma.channelMember.findMany({ where: { userId: u.id, channelId: { in: channels.map((c) => c.id) } } });
  const lastRead = new Map(reads.map((r) => [r.channelId, r.lastReadAt]));
  const data = await Promise.all(
    channels.map(async (c) => {
      const [last, unread] = await Promise.all([
        prisma.message.findFirst({ where: { channelId: c.id, deletedAt: null }, orderBy: { createdAt: "desc" }, include: { sender: { select: { name: true } } } }),
        prisma.message.count({ where: { channelId: c.id, deletedAt: null, senderId: { not: u.id }, ...(lastRead.get(c.id) ? { createdAt: { gt: lastRead.get(c.id)! } } : {}) } }),
      ]);
      return { ...channelView(u, c), unread, last: last && { body: last.body.slice(0, 80), senderName: last.sender.name, createdAt: last.createdAt } };
    }),
  );
  ok(res, { channels: data, canCreate: canCreateChannels(u), lockedDivisionId: isGlobalManager(u) ? null : u.divisionId });
});

// ───── Kelola channel ─────

chatRoutes.post("/channels", auth, validate(channelSchema), async (req, res) => {
  const u = req.user!;
  if (!canCreateChannels(u)) throw new AppError("FORBIDDEN", 403, "Hanya pengurus yang bisa membuat diskusi");
  const b = req.body as z.infer<typeof channelSchema>;
  const global = isGlobalManager(u);
  if (b.scope === "ALL" && !global) throw new AppError("FORBIDDEN", 403, "Kepala divisi hanya bisa membuat diskusi untuk divisinya");
  // Kadiv selalu terkunci ke divisinya; pengurus inti boleh memilih divisi mana pun (atau tanpa divisi untuk anggota pilihan).
  const divisionId = global ? (b.scope === "ALL" ? null : b.divisionId ?? null) : u.divisionId!;
  if (b.scope === "DIVISION") {
    if (!divisionId || !(await prisma.division.count({ where: { id: divisionId, period: { isActive: true } } }))) throw new AppError("VALIDATION", 400, "Pilih divisi");
  }
  const members = b.scope === "MEMBERS" ? await validMembers(b.memberIds, divisionId) : [];

  const c = await prisma.channel.create({
    data: {
      name: b.name, description: b.description || null, readOnly: b.readOnly, createdById: u.id, divisionId,
      type: b.scope === "ALL" ? "GENERAL" : b.scope === "DIVISION" ? "DIVISION" : "CUSTOM",
      members: b.scope === "MEMBERS" ? { create: [...new Set([...members, u.id])].map((userId) => ({ userId, isMember: true })) } : undefined,
    },
    include: { division: { select: { name: true } } },
  });
  await audit(req, "chat.channel_create", "Channel", c.id, null, { name: c.name, type: c.type, divisionId, members: members.length });
  await syncChannelRooms(c.id);
  ok(res, channelView(u, c), undefined, 201);
});

chatRoutes.patch("/channels/:id", auth, validate(updateChannelSchema), async (req, res) => {
  const u = req.user!;
  const c = await channelFor(u, String(req.params.id));
  if (!canManage(u, c)) throw new AppError("FORBIDDEN", 403, "Kamu tidak mengelola diskusi ini");
  const b = req.body as z.infer<typeof updateChannelSchema>;
  if (c.key && b.name && b.name !== c.name) throw new AppError("VALIDATION", 400, "Nama channel bawaan tidak bisa diubah");

  await prisma.$transaction(async (tx) => {
    await tx.channel.update({ where: { id: c.id }, data: { ...(b.name !== undefined ? { name: b.name } : {}), ...(b.description !== undefined ? { description: b.description || null } : {}), ...(b.readOnly !== undefined ? { readOnly: b.readOnly } : {}) } });
    if (b.memberIds && c.type === "CUSTOM") {
      // Pembuat diskusi selalu tetap jadi anggota (sama seperti saat dibuat).
      const ids = [...new Set([...(await validMembers(b.memberIds, c.divisionId)), ...(c.createdById ? [c.createdById] : [])])];
      await tx.channelMember.updateMany({ where: { channelId: c.id, userId: { notIn: ids } }, data: { isMember: false } });
      for (const userId of ids) await tx.channelMember.upsert({ where: { channelId_userId: { channelId: c.id, userId } }, update: { isMember: true }, create: { channelId: c.id, userId, isMember: true } });
    }
  });
  await audit(req, "chat.channel_update", "Channel", c.id, { name: c.name, readOnly: c.readOnly }, b);
  await syncChannelRooms(c.id);
  ok(res, channelView(u, (await prisma.channel.findUniqueOrThrow({ where: { id: c.id }, include: { division: { select: { name: true } } } }))));
});

// Diarsipkan (bukan dihapus permanen) supaya riwayat tetap tersimpan.
chatRoutes.delete("/channels/:id", auth, async (req, res) => {
  const u = req.user!;
  const c = await channelFor(u, String(req.params.id));
  if (!canManage(u, c)) throw new AppError("FORBIDDEN", 403, "Kamu tidak mengelola diskusi ini");
  if (c.key) throw new AppError("VALIDATION", 400, "Channel bawaan tidak bisa diarsipkan");
  await prisma.channel.update({ where: { id: c.id }, data: { archivedAt: new Date() } });
  await audit(req, "chat.channel_archive", "Channel", c.id, { name: c.name }, null);
  await syncChannelRooms(c.id);
  ok(res, null);
});

// Siapa saja yang bisa melihat channel ini.
chatRoutes.get("/channels/:id/members", auth, async (req, res) => {
  const u = req.user!;
  const c = await channelFor(u, String(req.params.id));
  const select = { id: true, name: true, avatarUrl: true } as const;
  const active = { period: { isActive: true }, user: { status: "ACTIVE" as const, deletedAt: null } };
  const users =
    c.type === "CUSTOM"
      ? (await prisma.channelMember.findMany({ where: { channelId: c.id, isMember: true, user: { deletedAt: null } }, select: { user: { select } }, orderBy: { user: { name: "asc" } } })).map((m) => m.user)
      : (await prisma.membership.findMany({
          where: { ...active, ...(c.type === "DIVISION" ? { divisionId: c.divisionId } : c.type === "CORE" ? { role: { key: { in: ["KETUM", "SEKRETARIS", "BENDAHARA", "KADIV"] } } } : { role: { key: { not: "SYS_ADMIN" } } }) },
          select: { user: { select } },
          orderBy: { user: { name: "asc" } },
          take: 300,
        })).map((m) => m.user);
  ok(res, users);
});

// ───── Pesan ─────

// Halaman pesan terbaru dulu; ?before=<id> untuk memuat yang lebih lama.
chatRoutes.get("/channels/:id/messages", auth, async (req, res) => {
  const c = await channelFor(req.user!, String(req.params.id));
  const take = Math.min(100, Number(req.query.limit) || 50);
  const before = req.query.before ? await prisma.message.findUnique({ where: { id: String(req.query.before) }, select: { createdAt: true } }) : null;
  const rows = await prisma.message.findMany({
    where: { channelId: c.id, ...(before ? { createdAt: { lt: before.createdAt } } : {}) },
    orderBy: { createdAt: "desc" },
    take: take + 1,
    include: messageInclude,
  });
  ok(res, rows.slice(0, take).reverse().map(toDto), { hasMore: rows.length > take });
});

chatRoutes.get("/channels/:id/pinned", auth, async (req, res) => {
  const c = await channelFor(req.user!, String(req.params.id));
  const rows = await prisma.message.findMany({ where: { channelId: c.id, pinned: true, deletedAt: null }, orderBy: { createdAt: "desc" }, take: 20, include: messageInclude });
  ok(res, rows.map(toDto));
});

chatRoutes.post("/channels/:id/messages", auth, sendLimiter, validate(bodySchema), async (req, res) => {
  const u = req.user!;
  const c = await channelFor(u, String(req.params.id));
  if (!canPost(u, c)) throw new AppError("FORBIDDEN", 403, "Hanya pengelola yang bisa mengirim pesan di sini");
  if (req.body.replyToId && !(await prisma.message.count({ where: { id: req.body.replyToId, channelId: c.id } }))) throw new AppError("VALIDATION", 400, "Pesan yang dibalas tidak ditemukan");
  const m = await prisma.message.create({ data: { channelId: c.id, senderId: u.id, body: req.body.body, replyToId: req.body.replyToId }, include: messageInclude });
  await prisma.channelMember.upsert({ where: { channelId_userId: { channelId: c.id, userId: u.id } }, update: { lastReadAt: m.createdAt }, create: { channelId: c.id, userId: u.id, lastReadAt: m.createdAt } });
  const dto = toDto(m);
  broadcast(c.id, "message:new", dto);
  ok(res, dto, undefined, 201);
});

chatRoutes.post("/channels/:id/read", auth, async (req, res) => {
  const u = req.user!;
  const c = await channelFor(u, String(req.params.id));
  await prisma.channelMember.upsert({ where: { channelId_userId: { channelId: c.id, userId: u.id } }, update: { lastReadAt: new Date() }, create: { channelId: c.id, userId: u.id, lastReadAt: new Date() } });
  ok(res, null);
});

async function messageFor(u: AuthUser, id: string) {
  const m = await prisma.message.findUnique({ where: { id }, include: { channel: { include: { members: { where: { userId: u.id }, select: { isMember: true } } } } } });
  if (!m || m.deletedAt || !canAccess(u, m.channel, !!m.channel.members[0]?.isMember)) throw new AppError("NOT_FOUND", 404, "Pesan tidak ditemukan");
  return m;
}

chatRoutes.patch("/messages/:id", auth, validate(bodySchema.pick({ body: true })), async (req, res) => {
  const m = await messageFor(req.user!, String(req.params.id));
  if (m.senderId !== req.user!.id) throw new AppError("FORBIDDEN", 403, "Hanya bisa mengedit pesan sendiri");
  const dto = toDto(await prisma.message.update({ where: { id: m.id }, data: { body: req.body.body, editedAt: new Date() }, include: messageInclude }));
  broadcast(m.channelId, "message:update", dto);
  ok(res, dto);
});

chatRoutes.delete("/messages/:id", auth, async (req, res) => {
  const u = req.user!;
  const m = await messageFor(u, String(req.params.id));
  const own = m.senderId === u.id;
  if (!own && !canManage(u, m.channel)) throw new AppError("FORBIDDEN", 403, "Tidak bisa menghapus pesan ini");
  const dto = toDto(await prisma.message.update({ where: { id: m.id }, data: { deletedAt: new Date(), pinned: false }, include: messageInclude }));
  if (!own) await audit(req, "chat.delete", "Message", m.id, { body: m.body, senderId: m.senderId }, null);
  broadcast(m.channelId, "message:update", dto);
  ok(res, dto);
});

chatRoutes.post("/messages/:id/pin", auth, async (req, res) => {
  const u = req.user!;
  const m = await messageFor(u, String(req.params.id));
  if (!canManage(u, m.channel)) throw new AppError("FORBIDDEN", 403, "Hanya pengelola yang bisa menyematkan pesan");
  const dto = toDto(await prisma.message.update({ where: { id: m.id }, data: { pinned: !m.pinned }, include: messageInclude }));
  broadcast(m.channelId, "message:update", dto);
  ok(res, dto);
});
