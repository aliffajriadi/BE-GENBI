import { z } from "zod";

// ───────────── RBAC (PRD bagian 2) ─────────────

export const ROLES = ["SYS_ADMIN", "KETUM", "WAKETUM", "SEKRETARIS", "BENDAHARA", "KADIV", "ANGGOTA"] as const;
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
  "signature.create": "Buat tanda tangan elektronik (QR)",
} as const;
export type PermissionKey = keyof typeof PERMISSIONS;

const ALL = Object.keys(PERMISSIONS) as PermissionKey[];

const KETUM_PERMISSIONS: PermissionKey[] = [
  "user.read", "event.read", "event.create", "event.manage_all", "attendance.read_all", "leave.decide",
  "points.read_all", "points.adjust", "article.write", "article.review", "article.publish",
  "finance.read", "admin.read", "admin.manage", "chat.moderate", "audit.read", "signature.create",
];

export const ROLE_PERMISSIONS: Record<RoleKey, PermissionKey[]> = {
  SYS_ADMIN: ALL,
  KETUM: KETUM_PERMISSIONS,
  WAKETUM: KETUM_PERMISSIONS, // default sama dengan Ketum; bisa dibedakan dari Pengaturan > Role
  SEKRETARIS: [
    "user.read", "user.manage", "event.read", "event.create", "event.manage_all", "attendance.read_all",
    "attendance.manual", "leave.decide", "points.read_all", "points.adjust", "points.rules",
    "article.write", "article.review", "article.publish", "finance.read", "admin.read", "admin.manage", "chat.moderate",
    "signature.create",
  ],
  BENDAHARA: [
    "event.read", "attendance.read_all", "points.read_all", "article.write", "finance.read", "finance.manage", "admin.read",
    "signature.create",
  ],
  KADIV: [
    "user.read", "event.read", "event.create", "leave.decide", "points.adjust", "article.write",
    "article.review", "finance.read", "admin.read", "chat.moderate", "signature.create",
  ],
  ANGGOTA: ["event.read", "article.write"],
};

// ───────────── Akses divisi yang bisa didelegasikan Kadiv ─────────────

export const DIVISION_AREAS = {
  events: { label: "Kegiatan & rapat divisi", desc: "Buat rapat/kegiatan divisi, buka absensi, atur peserta, putuskan izin", permissions: ["event.create", "leave.decide"] },
  chat: { label: "Diskusi divisi", desc: "Buat & atur diskusi untuk anggota divisi, moderasi pesan", permissions: ["chat.moderate"] },
  points: { label: "Poin anggota divisi", desc: "Beri atau koreksi poin keaktifan anggota divisi", permissions: ["points.adjust"] },
  // Tanpa permission global: akses kas divisi dicek langsung (finance.manage = kas organisasi milik Bendahara).
  planning: { label: "Papan planning", desc: "Atur kolom papan kanban divisi: tambah, ganti nama, urutkan, hapus", permissions: [] },
  signature: { label: "Tanda tangan elektronik", desc: "Buat QR tanda tangan untuk sertifikat, surat, atau dokumen acara divisi", permissions: ["signature.create"] },
  finance: { label: "Kas divisi", desc: "Buat iuran divisi, atur rekening, verifikasi bukti bayar & catat buku kas divisi", permissions: [] },
} as const satisfies Record<string, { label: string; desc: string; permissions: PermissionKey[] }>;
export type DivisionArea = keyof typeof DIVISION_AREAS;
export const divisionAccessSchema = z.object({ areas: z.array(z.enum(Object.keys(DIVISION_AREAS) as [DivisionArea, ...DivisionArea[]])) });

// Role dengan wewenang lintas divisi. Selain ini (Kadiv & anggota yang diberi akses) selalu dibatasi ke divisinya sendiri.
export const GLOBAL_ROLES: RoleKey[] = ["SYS_ADMIN", "KETUM", "WAKETUM", "SEKRETARIS"];
