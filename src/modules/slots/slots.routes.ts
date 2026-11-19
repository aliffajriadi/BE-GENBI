import { Router } from "express";
import { prisma, type Prisma } from "../../lib/prisma.js";
import { auth, requirePermission, type AuthUser } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import { slotJoinSchema, slotListSchema, updateSlotListSchema, type FormQuestion } from "../../shared/index.js";
import { AppError } from "../../utils/app-error.js";
import { ok } from "../../utils/response.js";
import { audit } from "../audit/audit.service.js";
import { checkAnswers } from "../forms/answers.js";

// Slot (/s/<slug>): pengganti list "yang mau ikut" di grup WA — kelompok, undangan/RSVP, sesi, dll.
// Buat & kelola: Kadiv/pengurus inti (event.create) atau admin. Lihat & pilih: anggota yang login. Satu anggota = satu pilihan per list.
// Jawaban peserta hanya untuk pembuat (tidak pernah dikirim ke halaman peserta lain).
export const slotsRoutes = Router();

type GroupInput = { id?: string; name: string; description?: string | null; capacity?: number | null };
const groupData = (g: GroupInput, position: number) => ({ name: g.name, description: g.description || null, capacity: g.capacity ?? null, position });
const canCreate = requirePermission("event.create", "admin.manage");
const canManage = (u: AuthUser, createdById: string) => createdById === u.id || u.permissions.has("admin.manage");
const code = (e: unknown) => (e as { code?: string }).code;
const isOpen = (l: { isOpen: boolean; closesAt: Date | null }) => l.isOpen && (!l.closesAt || l.closesAt > new Date());
const person = { select: { id: true, name: true, avatarUrl: true } };
const withGroups = { groups: { orderBy: { position: "asc" as const }, include: { entries: { orderBy: { createdAt: "asc" as const }, include: { user: person } } } } };

async function managed(u: AuthUser, id: string) {
  const l = await prisma.slotList.findUnique({ where: { id } });
  if (!l) throw new AppError("NOT_FOUND", 404, "List tidak ditemukan");
  if (!canManage(u, l.createdById)) throw new AppError("FORBIDDEN", 403, "Hanya pembuat list atau admin yang bisa mengelola");
  return l;
}

async function bySlug(slug: string) {
  const l = await prisma.slotList.findUnique({ where: { slug: slug.toLowerCase() } });
  if (!l) throw new AppError("NOT_FOUND", 404, "List tidak ditemukan");
  return l;
}

const slugTaken = (e: unknown) => { if (code(e) === "P2002") throw new AppError("CONFLICT", 409, "Slug sudah dipakai, pilih yang lain"); throw e; };

// ───── Kelola ─────

slotsRoutes.get("/slots", auth, canCreate, async (req, res) => {
  const u = req.user!;
  const rows = await prisma.slotList.findMany({
    where: u.permissions.has("admin.manage") ? {} : { createdById: u.id },
    orderBy: { updatedAt: "desc" },
    include: { createdBy: { select: { name: true } }, groups: { select: { capacity: true } }, _count: { select: { entries: true } } },
  });
  // capacity null = ada pilihan tanpa batas.
  ok(res, rows.map(({ groups, ...l }) => ({ ...l, capacity: groups.some((g) => g.capacity == null) ? null : groups.reduce((n, g) => n + g.capacity!, 0), groupCount: groups.length })));
});

slotsRoutes.post("/slots", auth, canCreate, validate(slotListSchema), async (req, res) => {
  const { groups, ...data } = req.body as { groups: GroupInput[] } & Record<string, unknown>;
  const l = await prisma.slotList
    .create({ data: { ...(data as { slug: string; title: string }), createdById: req.user!.id, groups: { create: groups.map(groupData) } } })
    .catch(slugTaken);
  await audit(req, "slot.create", "SlotList", l.id, null, { slug: l.slug, title: l.title });
  ok(res, l, undefined, 201);
});

slotsRoutes.get("/slots/:id", auth, async (req, res) => {
  const l = await managed(req.user!, String(req.params.id));
  ok(res, await prisma.slotList.findUniqueOrThrow({ where: { id: l.id }, include: withGroups }));
});

slotsRoutes.patch("/slots/:id", auth, validate(updateSlotListSchema), async (req, res) => {
  const l = await managed(req.user!, String(req.params.id));
  const { groups, ...data } = req.body as { groups?: GroupInput[] } & Record<string, unknown>;
  await prisma
    .$transaction(async (tx) => {
      if (Object.keys(data).length) await tx.slotList.update({ where: { id: l.id }, data });
      if (!groups) return;
      // Sinkron pilihan: yang punya id diubah, tanpa id dibuat, yang hilang dihapus (beserta anggotanya).
      const existing = new Set((await tx.slotGroup.findMany({ where: { listId: l.id }, select: { id: true } })).map((g) => g.id));
      const keep = groups.flatMap((g) => (g.id ? [g.id] : []));
      if (keep.some((id) => !existing.has(id))) throw new AppError("VALIDATION", 400, "Pilihan tidak dikenal");
      await tx.slotGroup.deleteMany({ where: { listId: l.id, id: { notIn: keep } } });
      for (const [position, g] of groups.entries()) {
        if (g.id) await tx.slotGroup.update({ where: { id: g.id }, data: groupData(g, position) });
        else await tx.slotGroup.create({ data: { listId: l.id, ...groupData(g, position) } });
      }
    })
    .catch(slugTaken);
  await audit(req, "slot.update", "SlotList", l.id, null, { slug: data.slug ?? l.slug });
  ok(res, { id: l.id });
});

slotsRoutes.delete("/slots/:id", auth, async (req, res) => {
  const l = await managed(req.user!, String(req.params.id));
  await prisma.slotList.delete({ where: { id: l.id } });
  await audit(req, "slot.delete", "SlotList", l.id, { slug: l.slug, title: l.title }, null);
  ok(res, null);
});

// Pembuat mengeluarkan seseorang dari list.
slotsRoutes.delete("/slot-entries/:id", auth, async (req, res) => {
  const e = await prisma.slotEntry.findUnique({ where: { id: String(req.params.id) }, include: { list: { select: { createdById: true } } } });
  if (!e) throw new AppError("NOT_FOUND", 404, "Peserta tidak ditemukan");
  if (!canManage(req.user!, e.list.createdById)) throw new AppError("FORBIDDEN", 403, "Hanya pembuat list atau admin yang bisa mengeluarkan peserta");
  await prisma.slotEntry.delete({ where: { id: e.id } });
  await audit(req, "slot.entry.remove", "SlotEntry", e.id, { listId: e.listId, groupId: e.groupId, userId: e.userId }, null);
  ok(res, null);
});

// ───── Lihat & gabung (anggota) ─────

slotsRoutes.get("/slot-view/:slug", auth, async (req, res) => {
  const l = await bySlug(String(req.params.slug));
  const full = await prisma.slotList.findUniqueOrThrow({ where: { id: l.id }, include: { ...withGroups, createdBy: { select: { name: true } } } });
  const mine = full.groups.flatMap((g) => g.entries).find((e) => e.userId === req.user!.id);
  ok(res, {
    title: full.title, description: full.description, closesAt: full.closesAt, open: isOpen(full), createdBy: full.createdBy.name, optionNoun: full.optionNoun, joinLabel: full.joinLabel,
    questions: full.questions ?? [], mineGroupId: mine?.groupId ?? null, myAnswers: mine?.answers ?? null, meId: req.user!.id,
    // Hanya foto & nama; jawaban orang lain tidak ikut dikirim.
    groups: full.groups.map((g) => ({ id: g.id, name: g.name, description: g.description, capacity: g.capacity, members: g.entries.map((e) => e.user) })),
  });
});

slotsRoutes.post("/slot-view/:slug/join", auth, validate(slotJoinSchema), async (req, res) => {
  const l = await bySlug(String(req.params.slug));
  if (!isOpen(l)) throw new AppError("CLOSED", 400, "Pendaftaran sudah ditutup");
  const userId = req.user!.id;
  const groupId: string = req.body.groupId;
  const checked = checkAnswers((l.questions ?? []) as FormQuestion[], req.body.answers);
  if ("error" in checked) throw new AppError("VALIDATION", 400, checked.error);
  const answers = checked.answers as Prisma.InputJsonObject;
  await prisma
    .$transaction(async (tx) => {
      // Kunci baris pilihan: klik bersamaan diantre, jadi kuota tidak bisa jebol.
      const [g] = await tx.$queryRaw<{ capacity: number | null }[]>`SELECT capacity FROM \`SlotGroup\` WHERE id = ${groupId} AND listId = ${l.id} FOR UPDATE`;
      if (!g) throw new AppError("VALIDATION", 400, "Pilihan tidak ada di list ini");
      const mine = await tx.slotEntry.findUnique({ where: { listId_userId: { listId: l.id, userId } } });
      // Pilihan sama = perbarui jawaban saja (tidak makan slot baru).
      if (mine?.groupId === groupId) return tx.slotEntry.update({ where: { id: mine.id }, data: { answers } });
      if (g.capacity != null && (await tx.slotEntry.count({ where: { groupId } })) >= g.capacity) throw new AppError("FULL", 409, "Pilihan ini sudah penuh");
      // Pindah = ganti groupId; waktu ikut direset supaya urutan di pilihan baru sesuai waktu masuk.
      if (mine) return tx.slotEntry.update({ where: { id: mine.id }, data: { groupId, answers, createdAt: new Date() } });
      return tx.slotEntry.create({ data: { listId: l.id, groupId, userId, answers } });
    })
    .catch((e) => { if (code(e) === "P2002") throw new AppError("CONFLICT", 409, "Kamu sudah terdaftar di list ini"); throw e; });
  ok(res, null, undefined, 201);
});

slotsRoutes.post("/slot-view/:slug/leave", auth, async (req, res) => {
  const l = await bySlug(String(req.params.slug));
  if (!isOpen(l)) throw new AppError("CLOSED", 400, "Pendaftaran sudah ditutup, hubungi pembuatnya untuk keluar");
  const { count } = await prisma.slotEntry.deleteMany({ where: { listId: l.id, userId: req.user!.id } });
  if (!count) throw new AppError("NOT_FOUND", 404, "Kamu belum memilih apa pun di list ini");
  ok(res, null);
});
