import { Router } from "express";
import { env } from "../../config/env.js";
import { prisma, type Prisma } from "../../lib/prisma.js";
import { auth, requirePermission, type AuthUser } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import {
  addActionItemSchema,
  dispositionSchema,
  documentSchema,
  letterSchema,
  minuteSchema,
  updateActionItemSchema,
  updateLetterSchema,
  updateMinuteSchema,
} from "../../shared/index.js";
import { AppError } from "../../utils/app-error.js";
import { paging } from "../../utils/paging.js";
import { ok } from "../../utils/response.js";
import { audit } from "../audit/audit.service.js";
import { canManage } from "../events/events.service.js";
import { notify } from "../notifications/notifications.service.js";
import { letterNumber } from "./letter-number.js";

export const administrationRoutes = Router();
const id = (v: unknown) => String(v);

async function fileUrlOf(fileId: string | undefined, userId: string) {
  if (!fileId) return undefined;
  const u = await prisma.upload.findUnique({ where: { id: fileId } });
  if (!u || u.ownerId !== userId) throw new AppError("VALIDATION", 400, "File tidak valid");
  return `/files/${u.id}`;
}

// ───── Surat ─────

administrationRoutes.get("/letters", auth, requirePermission("admin.read"), async (req, res) => {
  const { skip, take, page } = paging(req.query);
  const where: Prisma.LetterWhereInput = { deletedAt: null };
  if (req.query.direction) where.direction = String(req.query.direction) as "IN" | "OUT";
  if (req.query.q) where.OR = [{ subject: { contains: String(req.query.q) } }, { counterparty: { contains: String(req.query.q) } }, { number: { contains: String(req.query.q) } }];
  const [rows, total] = await Promise.all([
    prisma.letter.findMany({
      where,
      skip,
      take,
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      include: { dispositions: { include: { toUser: { select: { name: true } }, toDivision: { select: { name: true } } } } },
    }),
    prisma.letter.count({ where }),
  ]);
  ok(res, rows, { page, total });
});

administrationRoutes.post("/letters", auth, requirePermission("admin.manage"), validate(letterSchema), async (req, res) => {
  const { fileId, number, ...data } = req.body;
  let num = number;
  if (data.direction === "OUT") {
    const y = new Date(data.date.getTime() + 7 * 3_600_000).getUTCFullYear();
    const seq = (await prisma.letter.count({ where: { direction: "OUT", date: { gte: new Date(Date.UTC(y, 0, 1) - 7 * 3_600_000), lt: new Date(Date.UTC(y + 1, 0, 1) - 7 * 3_600_000) } } })) + 1;
    num = letterNumber(seq, env.LETTER_ORG, data.date);
  }
  const l = await prisma.letter.create({
    data: { ...data, number: num, fileUrl: await fileUrlOf(fileId, req.user!.id), status: data.status ?? (data.direction === "IN" ? "RECEIVED" : "DRAFT") },
  });
  await audit(req, "letter.create", "Letter", l.id, null, l);
  ok(res, l, undefined, 201);
});

administrationRoutes.patch("/letters/:id", auth, requirePermission("admin.manage"), validate(updateLetterSchema), async (req, res) => {
  const before = await prisma.letter.findUniqueOrThrow({ where: { id: id(req.params.id) } });
  const { fileId, ...data } = req.body;
  const l = await prisma.letter.update({ where: { id: before.id }, data: { ...data, ...(fileId ? { fileUrl: await fileUrlOf(fileId, req.user!.id) } : {}) } });
  await audit(req, "letter.update", "Letter", l.id, before, l);
  ok(res, l);
});

administrationRoutes.delete("/letters/:id", auth, requirePermission("admin.manage"), async (req, res) => {
  const l = await prisma.letter.update({ where: { id: id(req.params.id) }, data: { deletedAt: new Date() } });
  await audit(req, "letter.delete", "Letter", l.id, l, null);
  ok(res, null);
});

administrationRoutes.post("/letters/:id/disposition", auth, requirePermission("admin.manage"), validate(dispositionSchema), async (req, res) => {
  const l = await prisma.letter.findUniqueOrThrow({ where: { id: id(req.params.id) } });
  const d = await prisma.disposition.create({ data: { letterId: l.id, ...req.body } });
  const targets = req.body.toUserId
    ? [req.body.toUserId]
    : (await prisma.membership.findMany({ where: { divisionId: req.body.toDivisionId, period: { isActive: true }, role: { key: "KADIV" } }, select: { userId: true } })).map((m) => m.userId);
  await notify(targets, { type: "DISPOSITION", title: `Disposisi surat: ${l.subject}`, body: req.body.note, link: "/dashboard/admin?tab=letters" });
  ok(res, d, undefined, 201);
});

// ───── Notulen & tugas ─────

const minuteInclude = {
  event: { select: { id: true, title: true, type: true, startAt: true, location: true, createdById: true, divisionId: true } },
  actionItems: { include: { pic: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" } },
} as const;

// Pengurus (admin.read) lihat semua; anggota lihat notulen kegiatan yang dia ikuti.
const minuteWhere = (u: AuthUser): Prisma.MeetingMinuteWhereInput =>
  u.permissions.has("admin.read") ? {} : { event: { participants: { some: { userId: u.id } } } };

const canWriteMinute = (u: AuthUser, e: { createdById: string; divisionId: string | null }) => u.permissions.has("admin.manage") || canManage(u, e);

administrationRoutes.get("/minutes", auth, async (req, res) => {
  const { skip, take, page } = paging(req.query);
  const where = { ...minuteWhere(req.user!), ...(req.query.q ? { event: { title: { contains: String(req.query.q) } } } : {}) };
  const [rows, total] = await Promise.all([
    prisma.meetingMinute.findMany({ where, skip, take, orderBy: { event: { startAt: "desc" } }, include: minuteInclude }),
    prisma.meetingMinute.count({ where }),
  ]);
  ok(res, rows, { page, total });
});

administrationRoutes.get("/minutes/:id", auth, async (req, res) => {
  const m = await prisma.meetingMinute.findFirst({ where: { id: id(req.params.id), ...minuteWhere(req.user!) }, include: minuteInclude });
  if (!m) throw new AppError("NOT_FOUND", 404, "Notulen tidak ditemukan");
  // Peserta hadir diambil otomatis dari absensi.
  const present = await prisma.attendance.findMany({ where: { eventId: m.eventId, status: { in: ["HADIR", "TELAT"] } }, include: { user: { select: { name: true } } }, orderBy: { user: { name: "asc" } } });
  ok(res, { ...m, present: present.map((a) => a.user.name), canEdit: canWriteMinute(req.user!, m.event) });
});

administrationRoutes.post("/minutes", auth, validate(minuteSchema), async (req, res) => {
  const u = req.user!;
  const e = await prisma.event.findFirst({ where: { id: req.body.eventId, deletedAt: null } });
  if (!e) throw new AppError("NOT_FOUND", 404, "Kegiatan tidak ditemukan");
  if (!canWriteMinute(u, e)) throw new AppError("FORBIDDEN", 403, "Hanya pengelola kegiatan atau sekretaris");
  if (await prisma.meetingMinute.count({ where: { eventId: e.id } })) throw new AppError("CONFLICT", 409, "Kegiatan ini sudah punya notulen");
  const m = await prisma.meetingMinute.create({
    data: {
      eventId: e.id,
      content: req.body.content,
      decisions: req.body.decisions,
      actionItems: { create: req.body.actionItems.map((a: { title: string; picId: string; dueDate?: Date }) => ({ title: a.title, picId: a.picId, dueDate: a.dueDate })) },
    },
    include: minuteInclude,
  });
  for (const a of m.actionItems) await notify([a.pic.id], { type: "ACTION_ITEM", title: "Tugas baru dari rapat", body: `${a.title} · ${e.title}`, link: "/dashboard/admin?tab=tasks" });
  await audit(req, "minute.create", "MeetingMinute", m.id, null, { eventId: e.id });
  ok(res, m, undefined, 201);
});

administrationRoutes.patch("/minutes/:id", auth, validate(updateMinuteSchema), async (req, res) => {
  const m = await prisma.meetingMinute.findUniqueOrThrow({ where: { id: id(req.params.id) }, include: { event: true } });
  if (!canWriteMinute(req.user!, m.event)) throw new AppError("FORBIDDEN", 403, "Tidak bisa mengubah notulen ini");
  ok(res, await prisma.meetingMinute.update({ where: { id: m.id }, data: req.body, include: minuteInclude }));
});

administrationRoutes.post("/minutes/:id/action-items", auth, validate(addActionItemSchema), async (req, res) => {
  const m = await prisma.meetingMinute.findUniqueOrThrow({ where: { id: id(req.params.id) }, include: { event: true } });
  if (!canWriteMinute(req.user!, m.event)) throw new AppError("FORBIDDEN", 403, "Tidak bisa menambah tugas");
  const a = await prisma.actionItem.create({ data: { minuteId: m.id, ...req.body } });
  await notify([a.picId], { type: "ACTION_ITEM", title: "Tugas baru dari rapat", body: `${a.title} · ${m.event.title}`, link: "/dashboard/admin?tab=tasks" });
  ok(res, a, undefined, 201);
});

administrationRoutes.get("/action-items", auth, async (req, res) => {
  const u = req.user!;
  const all = req.query.scope === "all" && u.permissions.has("admin.read");
  const where: Prisma.ActionItemWhereInput = all ? {} : { picId: u.id };
  if (req.query.done === "0") where.done = false;
  ok(
    res,
    await prisma.actionItem.findMany({
      where,
      orderBy: [{ done: "asc" }, { dueDate: "asc" }],
      take: 200,
      include: { pic: { select: { id: true, name: true } }, minute: { select: { id: true, event: { select: { title: true, startAt: true } } } } },
    }),
  );
});

administrationRoutes.patch("/action-items/:id", auth, validate(updateActionItemSchema), async (req, res) => {
  const a = await prisma.actionItem.findUniqueOrThrow({ where: { id: id(req.params.id) } });
  if (a.picId !== req.user!.id && !req.user!.permissions.has("admin.manage")) throw new AppError("FORBIDDEN", 403, "Hanya PIC atau sekretaris");
  ok(res, await prisma.actionItem.update({ where: { id: a.id }, data: { done: req.body.done } }));
});

// ───── Arsip dokumen ─────

administrationRoutes.get("/documents", auth, async (req, res) => {
  const where: Prisma.DocumentWhereInput = { deletedAt: null, ...(req.user!.permissions.has("admin.read") ? {} : { visibility: "SEMUA" }) };
  if (req.query.category) where.category = String(req.query.category);
  if (req.query.q) where.title = { contains: String(req.query.q) };
  const [rows, categories] = await Promise.all([
    prisma.document.findMany({ where, orderBy: { createdAt: "desc" }, take: 200, include: { period: { select: { name: true } } } }),
    prisma.document.groupBy({ by: ["category"], where: { deletedAt: null }, _count: true }),
  ]);
  ok(res, { items: rows, categories: categories.map((c) => ({ name: c.category, count: c._count })) });
});

administrationRoutes.post("/documents", auth, requirePermission("admin.manage"), validate(documentSchema), async (req, res) => {
  const { fileId, ...data } = req.body;
  const d = await prisma.document.create({ data: { ...data, fileUrl: (await fileUrlOf(fileId, req.user!.id))!, periodId: req.user!.periodId } });
  await audit(req, "document.create", "Document", d.id, null, d);
  ok(res, d, undefined, 201);
});

administrationRoutes.delete("/documents/:id", auth, requirePermission("admin.manage"), async (req, res) => {
  const d = await prisma.document.update({ where: { id: id(req.params.id) }, data: { deletedAt: new Date() } });
  await audit(req, "document.delete", "Document", d.id, d, null);
  ok(res, null);
});
