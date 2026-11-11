import crypto from "node:crypto";
import { prisma, type AttendanceStatus, type Event, type Prisma } from "../../lib/prisma.js";
import type { CreateEventInput } from "../../shared/index.js";
import type { AuthUser } from "../../middlewares/auth.js";
import { cache } from "../../lib/cache.js";
import { AppError } from "../../utils/app-error.js";
import { award } from "../points/points.service.js";
import { notify } from "../notifications/notifications.service.js";
import { fmtWib } from "../../utils/date.js";
import { distanceM, eventToken, parseEventToken, verifyEventToken, verifyMemberToken } from "./qr.js";

export async function activePeriodId() {
  const p = await prisma.period.findFirst({ where: { isActive: true }, select: { id: true } });
  if (!p) throw new AppError("NO_ACTIVE_PERIOD", 500, "Belum ada periode aktif");
  return p.id;
}

// Pembuat, Kadiv divisi event, atau pemegang event.manage_all.
export function canManage(u: AuthUser, e: Pick<Event, "createdById" | "divisionId">) {
  const divisionManager = u.role === "KADIV" || u.divisionGrants.has("events");
  return u.permissions.has("event.manage_all") || e.createdById === u.id || (divisionManager && !!u.divisionId && e.divisionId === u.divisionId);
}

export async function getManageable(u: AuthUser, id: string) {
  const e = await prisma.event.findFirst({ where: { id, deletedAt: null } });
  if (!e) throw new AppError("NOT_FOUND", 404, "Kegiatan tidak ditemukan");
  if (!canManage(u, e)) throw new AppError("FORBIDDEN", 403, "Bukan kegiatan yang Anda kelola");
  return e;
}

// Calon peserta sebuah kegiatan (sebelum dibekukan saat absensi dibuka).
export async function scopeUserIds(e: Pick<Event, "id" | "scope" | "divisionId">) {
  if (e.scope === "MANUAL") return (await prisma.eventParticipant.findMany({ where: { eventId: e.id }, select: { userId: true } })).map((p) => p.userId);
  const rows = await prisma.membership.findMany({
    where: { period: { isActive: true }, user: { status: "ACTIVE", deletedAt: null }, role: { key: { not: "SYS_ADMIN" } }, ...(e.scope === "DIVISION" ? { divisionId: e.divisionId } : {}) },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

// Peserta pilihan harus anggota aktif periode berjalan; kalau kegiatan berlingkup divisi, harus anggota divisi itu.
export async function validParticipants(ids: string[], divisionId: string | null) {
  const unique = [...new Set(ids)];
  if (!unique.length) throw new AppError("VALIDATION", 400, "Pilih minimal satu peserta");
  const found = await prisma.membership.count({
    where: { userId: { in: unique }, period: { isActive: true }, user: { status: "ACTIVE", deletedAt: null }, ...(divisionId ? { divisionId } : {}) },
  });
  if (found !== unique.length) throw new AppError("VALIDATION", 400, divisionId ? "Ada peserta di luar divisi ini" : "Ada peserta yang tidak aktif");
  return unique;
}

export async function createEvent(u: AuthUser, input: CreateEventInput) {
  const { participantIds, ...data } = input;
  if (!u.permissions.has("event.manage_all")) {
    // Kadiv: kegiatan selalu milik divisinya — seluruh divisi, atau anggota pilihan dari divisinya saja.
    if (!u.divisionId) throw new AppError("FORBIDDEN", 403, "Anda tidak terikat ke divisi");
    data.divisionId = u.divisionId;
    if (data.scope !== "MANUAL") data.scope = "DIVISION";
  }
  const participants = data.scope === "MANUAL" ? await validParticipants(participantIds ?? [], data.divisionId ?? null) : [];
  const e = await prisma.event.create({
    data: {
      ...data,
      createdById: u.id,
      participants: participants.length ? { create: participants.map((userId) => ({ userId })) } : undefined,
    },
  });
  await notify((await scopeUserIds(e)).filter((id) => id !== u.id), { type: "EVENT_NEW", title: `Kegiatan baru: ${e.title}`, body: `${fmtWib(e.startAt)}${e.location ? ` · ${e.location}` : ""}`, link: `/dashboard/events/${e.id}` });
  return e;
}

// Peserta ALL/DIVISION dibekukan saat absensi dibuka, supaya daftar alpa saat tutup konsisten.
async function materializeParticipants(tx: Prisma.TransactionClient, e: Event, periodId: string) {
  if (e.scope === "MANUAL") return;
  const members = await tx.membership.findMany({
    where: { periodId, user: { status: "ACTIVE", deletedAt: null }, ...(e.scope === "DIVISION" ? { divisionId: e.divisionId } : {}), role: { key: { not: "SYS_ADMIN" } } },
    select: { userId: true },
  });
  await tx.eventParticipant.createMany({ data: members.map((m) => ({ eventId: e.id, userId: m.userId })), skipDuplicates: true });
}

export async function openAttendance(e: Event) {
  if (e.attendanceStatus !== "CLOSED") throw new AppError("INVALID_STATE", 409, "Absensi sudah dibuka atau sudah selesai");
  const periodId = await activePeriodId();
  const updated = await prisma.$transaction(async (tx) => {
    await materializeParticipants(tx, e, periodId);
    return tx.event.update({ where: { id: e.id }, data: { attendanceStatus: "OPEN", qrSecret: crypto.randomBytes(24).toString("base64url") } });
  });
  cache.del(`event:${e.id}`);
  return updated;
}

// Tutup: peserta tanpa absen → IZIN/SAKIT (kalau izin disetujui) atau ALPA, plus poin.
export async function closeAttendance(e: Event, actorId?: string) {
  if (e.attendanceStatus !== "OPEN") throw new AppError("INVALID_STATE", 409, "Absensi tidak sedang dibuka");
  const periodId = await activePeriodId();
  await prisma.$transaction(
    async (tx) => {
      const missing = await tx.eventParticipant.findMany({ where: { eventId: e.id, user: { attendances: { none: { eventId: e.id } } } }, select: { userId: true } });
      const leaves = await tx.leaveRequest.findMany({ where: { eventId: e.id, status: "APPROVED" } });
      const leaveBy = new Map(leaves.map((l) => [l.userId, l]));
      for (const { userId } of missing) {
        const leave = leaveBy.get(userId);
        const status: AttendanceStatus = leave ? leave.kind : "ALPA";
        const a = await tx.attendance.create({ data: { eventId: e.id, userId, status, method: "AUTO" } });
        await award(tx, { userId, periodId, ruleKey: leave ? "IZIN" : "ALPA", sourceType: "ATTENDANCE", sourceId: a.id, createdById: actorId, note: `${status}: ${e.title}` });
      }
      await tx.event.update({ where: { id: e.id }, data: { attendanceStatus: "DONE", qrSecret: null } });
    },
    { timeout: 30_000 },
  );
  cache.del(`event:${e.id}`);
}

export function currentQr(e: Event) {
  if (e.attendanceStatus !== "OPEN" || !e.qrSecret) throw new AppError("INVALID_STATE", 409, "Absensi belum dibuka");
  return eventToken(e.id, e.qrSecret);
}

async function cachedEvent(id: string) {
  const key = `event:${id}`;
  let e = cache.get<Event | null>(key);
  if (e === undefined) {
    e = await prisma.event.findFirst({ where: { id, deletedAt: null } });
    cache.set(key, e, 60);
  }
  return e;
}

async function record(
  e: Event,
  userId: string,
  method: "QR" | "SCAN_BALIK",
  extra: { deviceId?: string; lat?: number; lng?: number; actorId?: string },
) {
  const isParticipant = await prisma.eventParticipant.findUnique({ where: { eventId_userId: { eventId: e.id, userId } } });
  if (!isParticipant) throw new AppError("NOT_PARTICIPANT", 403, "Anda bukan peserta kegiatan ini");

  const now = new Date();
  const status: AttendanceStatus = now <= e.lateAfter ? "HADIR" : "TELAT";
  const periodId = await activePeriodId();
  try {
    return await prisma.$transaction(async (tx) => {
      const a = await tx.attendance.create({
        data: { eventId: e.id, userId, status, method, scannedAt: now, deviceId: extra.deviceId, lat: extra.lat, lng: extra.lng },
      });
      await award(tx, {
        userId,
        periodId,
        ruleKey: status,
        override: status === "HADIR" ? e.pointHadir : e.pointTelat,
        sourceType: "ATTENDANCE",
        sourceId: a.id,
        createdById: extra.actorId,
        note: `${status}: ${e.title}`,
      });
      return a;
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new AppError("ALREADY_RECORDED", 409, "Sudah tercatat absen");
    throw err;
  }
}

export async function scan(userId: string, input: { token: string; deviceId: string; lat?: number; lng?: number }) {
  const p = parseEventToken(input.token);
  if (!p) throw new AppError("INVALID_QR", 400, "QR tidak dikenali");
  const e = await cachedEvent(p.eventId);
  if (!e || e.attendanceStatus !== "OPEN" || !e.qrSecret) throw new AppError("NOT_OPEN", 409, "Absensi tidak sedang dibuka");
  const v = verifyEventToken(input.token, e.qrSecret);
  if (v === "INVALID") throw new AppError("INVALID_QR", 400, "QR tidak valid");
  if (v === "EXPIRED") throw new AppError("QR_EXPIRED", 400, "QR sudah kedaluwarsa, scan ulang QR terbaru");

  // Satu akun satu device; ganti device harus direset admin.
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { deviceId: true } });
  if (user.deviceId && user.deviceId !== input.deviceId) throw new AppError("DEVICE_MISMATCH", 403, "Akun terikat ke perangkat lain. Minta reset ke admin.");
  if (!user.deviceId) await prisma.user.update({ where: { id: userId }, data: { deviceId: input.deviceId } });

  if (e.geofenceOn && e.lat != null && e.lng != null && e.radiusM != null) {
    if (input.lat == null || input.lng == null) throw new AppError("LOCATION_REQUIRED", 400, "Aktifkan lokasi untuk absen kegiatan ini");
    if (distanceM(e.lat, e.lng, input.lat, input.lng) > e.radiusM) throw new AppError("OUT_OF_RANGE", 403, "Anda di luar lokasi kegiatan");
  }

  const a = await record(e, userId, "QR", { deviceId: input.deviceId, lat: input.lat, lng: input.lng });
  return { status: a.status, event: { id: e.id, title: e.title } };
}

export async function scanMember(u: AuthUser, eventId: string, memberToken: string) {
  const e = await getManageable(u, eventId);
  if (e.attendanceStatus !== "OPEN") throw new AppError("NOT_OPEN", 409, "Absensi tidak sedang dibuka");
  const userId = verifyMemberToken(memberToken);
  if (!userId) throw new AppError("INVALID_QR", 400, "QR anggota tidak valid");
  const a = await record(e, userId, "SCAN_BALIK", { actorId: u.id });
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  return { status: a.status, name: user?.name };
}

export async function attendanceSummary(eventId: string) {
  const [participants, rows] = await Promise.all([
    prisma.eventParticipant.findMany({ where: { eventId }, include: { user: { select: { id: true, name: true, nim: true } } } }),
    prisma.attendance.findMany({ where: { eventId } }),
  ]);
  const byUser = new Map(rows.map((r) => [r.userId, r]));
  const list = participants
    .map((p) => {
      const a = byUser.get(p.userId);
      return { userId: p.userId, name: p.user.name, nim: p.user.nim, status: a?.status ?? null, method: a?.method ?? null, scannedAt: a?.scannedAt ?? null };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const counts = { total: participants.length, HADIR: 0, TELAT: 0, IZIN: 0, SAKIT: 0, ALPA: 0, BELUM: 0 };
  for (const r of list) counts[r.status ?? "BELUM"]++;
  return { counts, list };
}
