import { z } from "zod";

export const EVENT_TYPES = ["RAPAT", "KEGIATAN", "KEPANITIAAN"] as const;

export const eventBaseSchema = z.object({
    title: z.string().min(3),
    type: z.enum(EVENT_TYPES),
    startAt: z.coerce.date(),
    endAt: z.coerce.date(),
    lateAfter: z.coerce.date(),
    location: z.string().optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
    radiusM: z.number().int().positive().optional(),
    geofenceOn: z.boolean().optional(),
    pointHadir: z.number().int().nullish(),
    pointTelat: z.number().int().nullish(),
    scope: z.enum(["ALL", "DIVISION", "MANUAL"]).optional(),
    divisionId: z.string().nullish(),
    participantIds: z.array(z.string()).optional(),
});

export const createEventSchema = eventBaseSchema
  .refine((e) => e.endAt > e.startAt, { message: "endAt harus setelah startAt", path: ["endAt"] })
  .refine((e) => e.lateAfter >= e.startAt && e.lateAfter <= e.endAt, { message: "Batas telat harus di antara mulai dan selesai", path: ["lateAfter"] })
  .refine((e) => e.scope !== "DIVISION" || !!e.divisionId, { message: "divisionId wajib untuk scope DIVISION", path: ["divisionId"] })
  .refine((e) => e.scope !== "MANUAL" || (e.participantIds?.length ?? 0) > 0, { message: "Isi daftar peserta", path: ["participantIds"] })
  .refine((e) => !e.geofenceOn || (e.lat != null && e.lng != null && e.radiusM != null), { message: "Geofence butuh lat, lng, radiusM", path: ["geofenceOn"] });

export const updateEventSchema = eventBaseSchema.omit({ participantIds: true, scope: true, divisionId: true }).partial();

export const scanSchema = z.object({
  token: z.string().min(10),
  deviceId: z.string().min(1).max(200),
  lat: z.number().optional(),
  lng: z.number().optional(),
});

export const scanMemberSchema = z.object({ eventId: z.string(), memberToken: z.string().min(10) });

export const manualAttendanceSchema = z.object({
  eventId: z.string(),
  userId: z.string(),
  status: z.enum(["HADIR", "TELAT", "IZIN", "SAKIT", "ALPA"]),
  reason: z.string().min(3),
});

export const leaveRequestSchema = z.object({
  kind: z.enum(["IZIN", "SAKIT"]).default("IZIN"),
  reason: z.string().min(3),
  attachmentUrl: z.string().optional(),
});

export const decideLeaveSchema = z.object({ status: z.enum(["APPROVED", "REJECTED"]) });
export type CreateEventInput = z.infer<typeof createEventSchema>;
export type ScanInput = z.infer<typeof scanSchema>;
