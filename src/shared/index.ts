import { z } from "zod";

// ───────────── RBAC (PRD bagian 2) ─────────────

export const ROLES = ["SYS_ADMIN", "KETUM", "SEKRETARIS", "BENDAHARA", "KADIV", "ANGGOTA"] as const;
export type RoleKey = (typeof ROLES)[number];

export const PERMISSIONS = {
  "user.read": "Lihat data anggota",
  "user.manage": "Kelola akun & data anggota",
  "role.manage": "Kelola role & permission",
  "division.manage": "Kelola divisi & periode",
  "event.read": "Lihat kegiatan",
  "event.create": "Buat kegiatan/rapat (Kadiv: divisinya)",
  "event.manage_all": "Kelola semua kegiatan",
  "attendance.read_all": "Lihat rekap absensi semua",
  "attendance.manual": "Input absensi manual",
  "leave.decide": "Putuskan izin (Kadiv: event divisinya)",
  "points.read_all": "Lihat poin semua anggota",
  "points.adjust": "Beri/koreksi poin (Kadiv: divisinya)",
  "points.rules": "Ubah aturan poin",
  "article.write": "Tulis draft artikel",
  "article.review": "Review artikel (Kadiv: divisinya)",
  "article.publish": "Publish artikel",
  "finance.read": "Lihat keuangan",
  "finance.manage": "Kelola uang kas",
  "admin.read": "Lihat administrasi",
  "admin.manage": "Kelola administrasi & arsip",
  "chat.moderate": "Moderasi chat",
  "audit.read": "Lihat audit log",
  "settings.manage": "Konfigurasi sistem",
} as const;
export type PermissionKey = keyof typeof PERMISSIONS;

const ALL = Object.keys(PERMISSIONS) as PermissionKey[];

export const ROLE_PERMISSIONS: Record<RoleKey, PermissionKey[]> = {
  SYS_ADMIN: ALL,
  KETUM: [
    "user.read", "event.read", "event.create", "event.manage_all", "attendance.read_all", "leave.decide",
    "points.read_all", "points.adjust", "article.write", "article.review", "article.publish",
    "finance.read", "admin.read", "admin.manage", "chat.moderate", "audit.read",
  ],
  SEKRETARIS: [
    "user.read", "user.manage", "event.read", "event.create", "event.manage_all", "attendance.read_all",
    "attendance.manual", "leave.decide", "points.read_all", "points.adjust", "points.rules",
    "article.write", "article.review", "article.publish", "finance.read", "admin.read", "admin.manage", "chat.moderate",
  ],
  BENDAHARA: [
    "event.read", "attendance.read_all", "points.read_all", "article.write", "finance.read", "finance.manage", "admin.read",
  ],
  KADIV: [
    "user.read", "event.read", "event.create", "leave.decide", "points.adjust", "article.write",
    "article.review", "finance.read", "admin.read", "chat.moderate",
  ],
  ANGGOTA: ["event.read", "article.write"],
};

// ───────────── Poin (PRD bagian 6) ─────────────

export const DEFAULT_POINT_RULES = [
  { key: "HADIR", label: "Hadir rapat", points: 10, trigger: "AUTO" },
  { key: "TELAT", label: "Hadir tapi telat", points: 5, trigger: "AUTO" },
  { key: "IZIN", label: "Izin disetujui", points: 0, trigger: "AUTO" },
  { key: "ALPA", label: "Alpa", points: -5, trigger: "AUTO" },
  { key: "ARTICLE_PUBLISHED", label: "Artikel dipublish", points: 15, trigger: "AUTO" },
  { key: "KAS_ON_TIME", label: "Bayar kas tepat waktu", points: 5, trigger: "AUTO" },
  { key: "PANITIA", label: "Jadi panitia kegiatan", points: 30, trigger: "MANUAL" },
  { key: "KONTRIBUSI", label: "Kontribusi lain", points: 0, trigger: "MANUAL" },
] as const;

// ───────────── Schema request ─────────────

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
  device: z.string().max(200).optional(),
});

export const refreshSchema = z.object({ refreshToken: z.string().min(10) });

export const createUserSchema = z.object({
  email: z.email(),
  name: z.string().min(2),
  password: z.string().min(8),
  nim: z.string().max(100).nullish(),
  phone: z.string().max(100).nullish(),
  campus: z.string().max(100).nullish(),
  major: z.string().max(100).nullish(),
  batch: z.string().max(100).nullish(),
  roleKey: z.enum(ROLES),
  divisionId: z.string().nullish(),
  position: z.string().optional(),
});

export const updateUserSchema = createUserSchema.omit({ password: true }).partial().extend({
  status: z.enum(["ACTIVE", "INACTIVE", "ALUMNI"]).optional(),
  resetDevice: z.boolean().optional(),
});

export const createDivisionSchema = z.object({
  name: z.string().min(2),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string().optional(),
});

export const createPeriodSchema = z.object({
  name: z.string().min(4),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
});

export const EVENT_TYPES = ["RAPAT_PLENO", "RAPAT_DIVISI", "KEGIATAN", "KEPANITIAAN"] as const;

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

export const adjustPointsSchema = z.object({
  userId: z.string(),
  points: z.number().int().refine((n) => n !== 0, "Poin tidak boleh 0"),
  ruleKey: z.string().optional(),
  note: z.string().min(3),
});

export const pointRuleSchema = z.object({
  key: z.string().regex(/^[A-Z0-9_]+$/),
  label: z.string().min(2),
  points: z.number().int(),
  trigger: z.enum(["AUTO", "MANUAL"]),
  isActive: z.boolean().default(true),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateEventInput = z.infer<typeof createEventSchema>;
export type ScanInput = z.infer<typeof scanSchema>;

// Format response seragam (PRD bagian 12)
export type ApiOk<T> = { success: true; data: T; meta?: unknown };
export type ApiErr = { success: false; error: { code: string; message: string; details?: unknown } };

// ───────────── Profil sendiri ─────────────

// "@nama", "nama", atau "https://instagram.com/nama/" → "nama". Kosong → null.
const handle = (max: number) =>
  z
    .string()
    .trim()
    .transform((v) => v.replace(/^https?:\/\/(www\.)?[^/]+\/@?/i, "").replace(/^@/, "").replace(/[/?#].*$/, ""))
    .pipe(z.string().max(max).regex(/^[A-Za-z0-9._]*$/, "Username hanya huruf, angka, titik, dan garis bawah"))
    .transform((v) => v || null);

// LinkedIn: simpan slug dari linkedin.com/in/<slug> (huruf, angka, tanda hubung).
const linkedin = z
  .string()
  .trim()
  .transform((v) => v.replace(/^(https?:\/\/)?([a-z]{2,3}\.)?(www\.)?linkedin\.com\/in\//i, "").replace(/^@/, "").replace(/[/?#].*$/, ""))
  .pipe(z.string().max(100).regex(/^([A-Za-z0-9-]{3,100})?$/, "Isi username LinkedIn (bagian setelah linkedin.com/in/)"))
  .transform((v) => v || null);

export const updateMeSchema = z.object({
  name: z.string().min(2).optional(),
  phone: z.string().max(30).nullish(),
  campus: z.string().max(100).nullish(),
  major: z.string().max(100).nullish(),
  batch: z.string().max(10).nullish(),
  avatarUrl: z.string().max(300).nullish(), // URL dari POST /uploads (public=true); null = hapus foto
  coverUrl: z.string().max(300).nullish(), // latar profil, aturan sama dengan avatarUrl
  bio: z.string().trim().max(300).nullish(),
  // Username saja; "@" dan URL lengkap dibuang supaya tautan selalu dibuat server-side ke domain resmi.
  instagram: handle(30).nullish(),
  tiktok: handle(24).nullish(),
  linkedin: linkedin.nullish(),
  website: z.url({ protocol: /^https?$/, message: "Website harus diawali http:// atau https://" }).max(200).nullish(),
  profilePublic: z.boolean().optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, "Password baru minimal 8 karakter"),
});

export const updateDivisionSchema = z.object({
  name: z.string().min(2).optional(),
  description: z.string().nullish(),
});

// ───────────── Keuangan ─────────────

export const bankAccountSchema = z.object({
  bankName: z.string().min(2),
  accountNumber: z.string().min(3).max(40),
  accountName: z.string().min(2),
  qrisImageUrl: z.string().nullish(),
  isActive: z.boolean().optional(),
});

export const duesPlanSchema = z
  .object({
    name: z.string().min(2),
    amount: z.number().int().positive(),
    frequency: z.enum(["MONTHLY", "SEMESTER", "ONCE"]),
    dueDay: z.number().int().min(1).max(28).optional(),
    dueDate: z.coerce.date().optional(),
    scope: z.enum(["ALL", "DIVISION"]).default("ALL"),
    divisionId: z.string().nullish(),
  })
  .refine((p) => p.frequency !== "ONCE" || !!p.dueDate, { message: "Iuran sekali bayar butuh tanggal jatuh tempo", path: ["dueDate"] })
  .refine((p) => p.scope !== "DIVISION" || !!p.divisionId, { message: "Pilih divisi", path: ["divisionId"] });

export const updateDuesPlanSchema = z.object({ name: z.string().min(2).optional(), amount: z.number().int().positive().optional(), isActive: z.boolean().optional() });

export const paymentSchema = z.object({
  billIds: z.array(z.string()).min(1, "Pilih minimal satu tagihan"),
  amount: z.number().int().positive(),
  transferDate: z.coerce.date(),
  proofId: z.string().min(1, "Upload bukti transfer"),
});

export const rejectSchema = z.object({ reason: z.string().min(3, "Isi alasan penolakan") });

export const cashTransactionSchema = z.object({
  type: z.enum(["IN", "OUT"]),
  category: z.string().min(2),
  amount: z.number().int().positive(),
  date: z.coerce.date(),
  description: z.string().optional(),
  attachmentId: z.string().optional(),
});

// ───────────── Artikel ─────────────

export const ARTICLE_KINDS = ["NEWS", "PERSONAL"] as const;
export const createArticleSchema = z.object({ title: z.string().min(3), kind: z.enum(ARTICLE_KINDS).default("PERSONAL") });

export const updateArticleSchema = z.object({
  title: z.string().min(3).optional(),
  slug: z.string().regex(/^[a-z0-9-]+$/, "Slug hanya huruf kecil, angka, dan tanda -").optional(),
  excerpt: z.string().max(300).nullish(),
  body: z.string().max(200_000).optional(),
  coverUrl: z.string().nullish(),
  coverAlt: z.string().max(200).nullish(),
  seoTitle: z.string().max(70).nullish(),
  seoDesc: z.string().max(160).nullish(),
  tags: z.array(z.string().min(1).max(30)).max(8).optional(),
  kind: z.enum(ARTICLE_KINDS).optional(),
});

export const publishArticleSchema = z.object({ scheduledAt: z.coerce.date().optional() });

// ───────────── Administrasi ─────────────

export const letterSchema = z.object({
  direction: z.enum(["IN", "OUT"]),
  subject: z.string().min(3),
  counterparty: z.string().min(2),
  date: z.coerce.date(),
  number: z.string().max(80).optional(), // surat masuk: nomor dari pengirim; surat keluar: otomatis
  fileId: z.string().optional(),
  status: z.enum(["DRAFT", "SIGNED", "SENT", "RECEIVED", "ARCHIVED"]).optional(),
});
export const updateLetterSchema = letterSchema.omit({ direction: true }).partial();

export const dispositionSchema = z
  .object({ toUserId: z.string().optional(), toDivisionId: z.string().optional(), note: z.string().optional() })
  .refine((d) => d.toUserId || d.toDivisionId, { message: "Pilih tujuan disposisi" });

const actionItemInput = z.object({ title: z.string().min(2), picId: z.string(), dueDate: z.coerce.date().optional() });

export const minuteSchema = z.object({
  eventId: z.string(),
  content: z.string().min(5),
  decisions: z.string().optional(),
  actionItems: z.array(actionItemInput).default([]),
});
export const updateMinuteSchema = z.object({ content: z.string().min(5).optional(), decisions: z.string().optional() });
export const addActionItemSchema = actionItemInput;
export const updateActionItemSchema = z.object({ done: z.boolean() });

export const documentSchema = z.object({
  title: z.string().min(2),
  category: z.string().min(2).max(40),
  fileId: z.string(),
  visibility: z.enum(["PENGURUS", "SEMUA"]).default("PENGURUS"),
});

// ───────────── Tampilan web publik ─────────────

export const siteSchema = z.object({
  heroImage: z.string().max(300).nullable(), // URL dari POST /uploads (public=true); null = tanpa foto
  heroAlt: z.string().max(200).optional(),
  headline: z.string().min(3).max(120),
  subheadline: z.string().max(300).optional(),
});
export type SiteContent = z.infer<typeof siteSchema>;

// Versi aplikasi mobile: di bawah minVersion = wajib update (app diblokir); di bawah latestVersion = disarankan.
const semver = z.string().regex(/^\d+\.\d+\.\d+$/, "Format versi: 1.2.3");
export const appVersionSchema = z
  .object({
    minVersion: semver,
    latestVersion: semver,
    url: z.string().url("Link unduhan tidak valid").regex(/^https?:\/\//, "Link harus http(s)").max(500),
    message: z.string().max(300).optional(),
  })
  .refine((v) => compareVersion(v.minVersion, v.latestVersion) <= 0, { message: "Versi minimal tidak boleh lebih baru dari versi terbaru", path: ["minVersion"] });
export type AppVersion = z.infer<typeof appVersionSchema>;

/** -1 / 0 / 1 untuk versi "x.y.z". */
export function compareVersion(a: string, b: string) {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  return 0;
}

// ───────────── Akses divisi yang bisa didelegasikan Kadiv ─────────────

export const DIVISION_AREAS = {
  events: { label: "Kegiatan & rapat divisi", desc: "Buat rapat/kegiatan divisi, buka absensi, atur peserta, putuskan izin", permissions: ["event.create", "leave.decide"] },
  chat: { label: "Diskusi divisi", desc: "Buat & atur diskusi untuk anggota divisi, moderasi pesan", permissions: ["chat.moderate"] },
  points: { label: "Poin anggota divisi", desc: "Beri atau koreksi poin keaktifan anggota divisi", permissions: ["points.adjust"] },
  // Tanpa permission global: akses kas divisi dicek langsung (finance.manage = kas organisasi milik Bendahara).
  planning: { label: "Papan planning", desc: "Atur kolom papan kanban divisi: tambah, ganti nama, urutkan, hapus", permissions: [] },
  finance: { label: "Kas divisi", desc: "Buat iuran divisi, atur rekening, verifikasi bukti bayar & catat buku kas divisi", permissions: [] },
} as const satisfies Record<string, { label: string; desc: string; permissions: PermissionKey[] }>;
export type DivisionArea = keyof typeof DIVISION_AREAS;
export const divisionAccessSchema = z.object({ areas: z.array(z.enum(Object.keys(DIVISION_AREAS) as [DivisionArea, ...DivisionArea[]])) });

// Role dengan wewenang lintas divisi. Selain ini (Kadiv & anggota yang diberi akses) selalu dibatasi ke divisinya sendiri.
export const GLOBAL_ROLES: RoleKey[] = ["SYS_ADMIN", "KETUM", "SEKRETARIS"];

// ───────────── Planning divisi (kanban) ─────────────
export const boardColumnSchema = z.object({ name: z.string().trim().min(1, "Nama kolom wajib diisi").max(40) });
export const updateColumnSchema = z.object({ name: z.string().trim().min(1).max(40).optional(), isDone: z.boolean().optional(), position: z.number().int().min(0).optional() });
const checklistItem = z.object({ id: z.string().min(1).max(40), text: z.string().trim().min(1).max(200), done: z.boolean() });
export const boardCardSchema = z.object({
  columnId: z.string().min(1),
  title: z.string().trim().min(1, "Judul kartu wajib diisi").max(200),
  description: z.string().max(5000).nullish(),
  assigneeId: z.string().nullish(),
  dueDate: z.coerce.date().nullish(),
});
export const updateCardSchema = boardCardSchema.omit({ columnId: true }).partial().extend({ checklist: z.array(checklistItem).max(50).optional() });
export const moveCardSchema = z.object({ columnId: z.string().min(1), index: z.number().int().min(0) });
