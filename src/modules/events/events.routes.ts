import { Router } from "express";
import ExcelJS from "exceljs";
import { z } from "zod";
import { prisma, type Prisma } from "../../lib/prisma.js";
import {
  createEventSchema,
  decideLeaveSchema,
  leaveRequestSchema,
  manualAttendanceSchema,
  scanMemberSchema,
  scanSchema,
  updateEventSchema,
} from "../../shared/index.js";
import { auth, requirePermission } from "../../middlewares/auth.js";
import { scanLimiter } from "../../middlewares/rate-limit.js";
import { validate } from "../../middlewares/validate.js";
import { AppError } from "../../utils/app-error.js";
import { ok } from "../../utils/response.js";
import { audit } from "../audit/audit.service.js";
import { award } from "../points/points.service.js";
import { notify } from "../notifications/notifications.service.js";
import * as svc from "./events.service.js";

export const eventsRoutes = Router();

const param = (v: unknown) => String(v);

// Kegiatan yang relevan untuk user: semua (scope ALL), divisinya, atau dia peserta. Pengelola lihat semua.
eventsRoutes.get("/events", auth, requirePermission("event.read"), async (req, res) => {
  const u = req.user!;
  const where: Prisma.EventWhereInput = { deletedAt: null };
  if (!u.permissions.has("event.manage_all") && !u.permissions.has("attendance.read_all")) {
    // Kegiatan peserta-pilihan hanya terlihat oleh yang dipilih; Kadiv (pengelola) melihat semua kegiatan divisinya.
    where.OR = [
      { scope: "ALL" },
      { participants: { some: { userId: u.id } } },
      { createdById: u.id },
      ...(u.divisionId ? [u.role === "KADIV" || u.divisionGrants.has("events") ? { divisionId: u.divisionId } : { scope: "DIVISION" as const, divisionId: u.divisionId }] : []),
    ];
  }
  if (req.query.upcoming === "1") where.endAt = { gte: new Date() };
  const events = await prisma.event.findMany({
    where,
    orderBy: { startAt: req.query.upcoming === "1" ? "asc" : "desc" },
    take: 100,
    include: {
      division: { select: { name: true } },
      createdBy: { select: { name: true } },
      attendances: { where: { userId: u.id }, select: { status: true } },
      leaveRequests: { where: { userId: u.id }, select: { status: true, kind: true } },
    },
    omit: { qrSecret: true },
  });
  ok(
    res,
    events.map(({ attendances, leaveRequests, ...e }) => ({ ...e, myAttendance: attendances[0]?.status ?? null, myLeave: leaveRequests[0] ?? null, canManage: svc.canManage(u, e) })),
  );
});

eventsRoutes.post("/events", auth, requirePermission("event.create"), validate(createEventSchema), async (req, res) => {
  const e = await svc.createEvent(req.user!, req.body);
  await audit(req, "event.create", "Event", e.id, null, e);
  ok(res, e, undefined, 201);
});

eventsRoutes.get("/events/:id", auth, requirePermission("event.read"), async (req, res) => {
  const e = await prisma.event.findFirst({
    where: { id: param(req.params.id), deletedAt: null },
    include: { division: { select: { id: true, name: true } }, createdBy: { select: { id: true, name: true } } },
    omit: { qrSecret: true },
  });
  if (!e) throw new AppError("NOT_FOUND", 404, "Kegiatan tidak ditemukan");
  ok(res, { ...e, canManage: svc.canManage(req.user!, e) });
});

eventsRoutes.patch("/events/:id", auth, validate(updateEventSchema), async (req, res) => {
  const e = await svc.getManageable(req.user!, param(req.params.id));
  if (e.attendanceStatus === "DONE") throw new AppError("INVALID_STATE", 409, "Absensi sudah ditutup, kegiatan tidak bisa diubah");
  const m = { ...e, ...req.body };
  if (m.endAt <= m.startAt || m.lateAfter < m.startAt || m.lateAfter > m.endAt) throw new AppError("VALIDATION", 400, "Urutan waktu mulai/telat/selesai tidak valid");
  const updated = await prisma.event.update({ where: { id: e.id }, data: req.body, omit: { qrSecret: true } });
  await audit(req, "event.update", "Event", e.id, e, updated);
  ok(res, updated);
});

// Peserta pilihan (scope MANUAL). Kadiv hanya bisa memilih anggota divisinya.
eventsRoutes.get("/events/:id/participants", auth, async (req, res) => {
  const e = await svc.getManageable(req.user!, param(req.params.id));
  const rows = await prisma.eventParticipant.findMany({ where: { eventId: e.id }, select: { user: { select: { id: true, name: true, avatarUrl: true } } }, orderBy: { user: { name: "asc" } } });
  ok(res, rows.map((r) => r.user));
});

eventsRoutes.put("/events/:id/participants", auth, validate(z.object({ participantIds: z.array(z.string()).max(500) })), async (req, res) => {
  const e = await svc.getManageable(req.user!, param(req.params.id));
  if (e.scope !== "MANUAL") throw new AppError("VALIDATION", 400, "Peserta hanya bisa diatur untuk kegiatan dengan peserta pilihan");
  if (e.attendanceStatus !== "CLOSED") throw new AppError("INVALID_STATE", 409, "Peserta tidak bisa diubah setelah absensi dibuka");
  const ids = await svc.validParticipants(req.body.participantIds, e.divisionId);
  const before = (await prisma.eventParticipant.findMany({ where: { eventId: e.id }, select: { userId: true } })).map((p) => p.userId);
  await prisma.$transaction([
    prisma.eventParticipant.deleteMany({ where: { eventId: e.id, userId: { notIn: ids } } }),
    prisma.eventParticipant.createMany({ data: ids.map((userId) => ({ eventId: e.id, userId })), skipDuplicates: true }),
  ]);
  const added = ids.filter((id) => !before.includes(id));
  await notify(added, { type: "EVENT_NEW", title: `Kamu diundang: ${e.title}`, link: `/dashboard/events/${e.id}` });
  await audit(req, "event.participants", "Event", e.id, before, ids);
  ok(res, { count: ids.length });
});

eventsRoutes.delete("/events/:id", auth, async (req, res) => {
  const e = await svc.getManageable(req.user!, param(req.params.id));
  await prisma.event.update({ where: { id: e.id }, data: { deletedAt: new Date() } });
  await audit(req, "event.delete", "Event", e.id, e, null);
  ok(res, null);
});

eventsRoutes.post("/events/:id/open", auth, async (req, res) => {
  const e = await svc.openAttendance(await svc.getManageable(req.user!, param(req.params.id)));
  ok(res, { attendanceStatus: e.attendanceStatus });
});

eventsRoutes.post("/events/:id/close", auth, async (req, res) => {
  const e = await svc.getManageable(req.user!, param(req.params.id));
  await svc.closeAttendance(e, req.user!.id);
  await audit(req, "attendance.close", "Event", e.id);
  ok(res, await svc.attendanceSummary(e.id));
});

// Dipoll layar panitia tiap beberapa detik: token QR terbaru + jumlah hadir.
eventsRoutes.get("/events/:id/qr-token", auth, async (req, res) => {
  const e = await svc.getManageable(req.user!, param(req.params.id));
  const qr = svc.currentQr(e);
  const { counts } = await svc.attendanceSummary(e.id);
  ok(res, { ...qr, serverTime: Date.now(), counts });
});

eventsRoutes.get("/events/:id/attendance", auth, async (req, res) => {
  const id = param(req.params.id);
  if (!req.user!.permissions.has("attendance.read_all")) await svc.getManageable(req.user!, id);
  ok(res, await svc.attendanceSummary(id));
});

eventsRoutes.get("/events/:id/attendance/export", auth, async (req, res) => {
  const id = param(req.params.id);
  if (!req.user!.permissions.has("attendance.read_all")) await svc.getManageable(req.user!, id);
  const e = await prisma.event.findUniqueOrThrow({ where: { id } });
  const { list } = await svc.attendanceSummary(id);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Absensi");
  ws.columns = [
    { header: "No", key: "no", width: 5 },
    { header: "Nama", key: "name", width: 30 },
    { header: "NIM", key: "nim", width: 15 },
    { header: "Status", key: "status", width: 10 },
    { header: "Metode", key: "method", width: 12 },
    { header: "Waktu", key: "scannedAt", width: 20 },
  ];
  list.forEach((r, i) => ws.addRow({ ...r, no: i + 1, status: r.status ?? "BELUM", scannedAt: r.status && r.method !== "AUTO" ? r.scannedAt : "" }));
  ws.getRow(1).font = { bold: true };
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="absensi-${e.title.replace(/[^\w-]+/g, "_")}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

eventsRoutes.post("/attendance/scan", auth, scanLimiter, validate(scanSchema), async (req, res) => {
  ok(res, await svc.scan(req.user!.id, req.body));
});

eventsRoutes.post("/attendance/scan-member", auth, validate(scanMemberSchema), async (req, res) => {
  ok(res, await svc.scanMember(req.user!, req.body.eventId, req.body.memberToken));
});

// Input/koreksi manual oleh Sekretaris: wajib alasan, tercatat di audit log.
// Koreksi tidak menimpa ledger: poin lama dibalik dengan baris negatif, lalu poin status baru ditambahkan.
eventsRoutes.post("/attendance/manual", auth, requirePermission("attendance.manual"), validate(manualAttendanceSchema), async (req, res) => {
  const { eventId, userId, status, reason } = req.body;
  const e = await prisma.event.findFirst({ where: { id: eventId, deletedAt: null } });
  if (!e) throw new AppError("NOT_FOUND", 404, "Kegiatan tidak ditemukan");
  const periodId = await svc.activePeriodId();
  const u = req.user!;

  const result = await prisma.$transaction(async (tx) => {
    await tx.eventParticipant.upsert({ where: { eventId_userId: { eventId, userId } }, update: {}, create: { eventId, userId } });
    const before = await tx.attendance.findUnique({ where: { eventId_userId: { eventId, userId } } });
    if (before) {
      const prev = await tx.pointLedger.aggregate({ where: { sourceType: "ATTENDANCE", sourceId: before.id }, _sum: { points: true } });
      const prevPoints = prev._sum.points ?? 0;
      if (prevPoints !== 0) {
        await tx.pointLedger.create({ data: { userId, periodId, points: -prevPoints, sourceType: "ATTENDANCE", sourceId: before.id, note: `Koreksi absensi: ${e.title}`, createdById: u.id } });
      }
    }
    const a = before
      ? await tx.attendance.update({ where: { id: before.id }, data: { status, method: "MANUAL", note: reason } })
      : await tx.attendance.create({ data: { eventId, userId, status, method: "MANUAL", note: reason } });
    const ruleKey = status === "SAKIT" ? "IZIN" : status;
    const override = status === "HADIR" ? e.pointHadir : status === "TELAT" ? e.pointTelat : undefined;
    await award(tx, { userId, periodId, ruleKey, override, sourceType: "ATTENDANCE", sourceId: a.id, createdById: u.id, note: `${status} (manual): ${e.title}` });
    await audit(req, "attendance.manual", "Attendance", a.id, before, { ...a, reason }, tx);
    return a;
  });
  ok(res, result);
});

// Rekap per anggota (persentase hadir) untuk satu periode; ?divisionId= untuk evaluasi per divisi.
eventsRoutes.get("/attendance/recap", auth, async (req, res) => {
  const u = req.user!;
  let divisionId = req.query.divisionId ? String(req.query.divisionId) : undefined;
  if (!u.permissions.has("attendance.read_all")) {
    if (u.role !== "KADIV" || !u.divisionId) throw new AppError("FORBIDDEN", 403, "Tidak punya akses");
    divisionId = u.divisionId;
  }
  const period = await prisma.period.findUniqueOrThrow({ where: { id: String(req.query.periodId ?? u.periodId) } });
  const members = await prisma.membership.findMany({
    where: { periodId: period.id, ...(divisionId ? { divisionId } : {}), role: { key: { not: "SYS_ADMIN" } } },
    include: { user: { select: { id: true, name: true, nim: true } }, division: { select: { name: true } } },
  });
  const rows = await prisma.attendance.groupBy({
    by: ["userId", "status"],
    where: { userId: { in: members.map((m) => m.userId) }, event: { deletedAt: null, startAt: { gte: period.startDate, lt: period.endDate }, attendanceStatus: "DONE" } },
    _count: true,
  });
  const recap = members.map((m) => {
    const c = { HADIR: 0, TELAT: 0, IZIN: 0, SAKIT: 0, ALPA: 0 };
    for (const r of rows) if (r.userId === m.userId) c[r.status] = r._count;
    const total = c.HADIR + c.TELAT + c.IZIN + c.SAKIT + c.ALPA;
    return { userId: m.userId, name: m.user.name, nim: m.user.nim, division: m.division?.name ?? null, ...c, total, percent: total ? Math.round(((c.HADIR + c.TELAT) / total) * 100) : null };
  });
  ok(res, recap.sort((a, b) => a.name.localeCompare(b.name)));
});

eventsRoutes.get("/attendance/me", auth, async (req, res) => {
  ok(
    res,
    await prisma.attendance.findMany({
      where: { userId: req.user!.id },
      orderBy: { scannedAt: "desc" },
      take: 100,
      include: { event: { select: { id: true, title: true, type: true, startAt: true } } },
    }),
  );
});

// ───── Izin ─────

eventsRoutes.post("/events/:id/leave-requests", auth, validate(leaveRequestSchema), async (req, res) => {
  const e = await prisma.event.findFirst({ where: { id: param(req.params.id), deletedAt: null } });
  if (!e) throw new AppError("NOT_FOUND", 404, "Kegiatan tidak ditemukan");
  if (e.attendanceStatus === "DONE") throw new AppError("INVALID_STATE", 409, "Absensi kegiatan sudah ditutup");
  const lr = await prisma.leaveRequest.create({ data: { ...req.body, eventId: e.id, userId: req.user!.id }, include: { user: { select: { name: true } } } });
  await notify([e.createdById], { type: "LEAVE_NEW", title: `Pengajuan ${lr.kind.toLowerCase()} dari ${lr.user.name}`, body: `${e.title}: ${lr.reason}`, link: `/dashboard/events/${e.id}` });
  ok(res, lr, undefined, 201);
});

eventsRoutes.get("/events/:id/leave-requests", auth, async (req, res) => {
  const e = await svc.getManageable(req.user!, param(req.params.id));
  ok(res, await prisma.leaveRequest.findMany({ where: { eventId: e.id }, include: { user: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" } }));
});

eventsRoutes.patch("/leave-requests/:id", auth, requirePermission("leave.decide"), validate(decideLeaveSchema), async (req, res) => {
  const lr = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: param(req.params.id) }, include: { event: true } });
  await svc.getManageable(req.user!, lr.eventId);
  if (lr.event.attendanceStatus === "DONE") throw new AppError("INVALID_STATE", 409, "Absensi sudah ditutup; pakai input manual");
  const updated = await prisma.leaveRequest.update({ where: { id: lr.id }, data: { status: req.body.status, decidedById: req.user!.id } });
  await audit(req, "leave.decide", "LeaveRequest", lr.id, lr, updated);
  await notify([lr.userId], { type: "LEAVE_DECIDED", title: `Izin ${updated.status === "APPROVED" ? "disetujui" : "ditolak"}`, body: lr.event.title, link: `/dashboard/events/${lr.eventId}` });
  ok(res, updated);
});
