import crypto from "node:crypto";
import { Router } from "express";
import bcrypt from "bcryptjs";
import ExcelJS from "exceljs";
import multer from "multer";
import { prisma } from "../../lib/prisma.js";
import { auth, requirePermission } from "../../middlewares/auth.js";
import { createUserSchema, type RoleKey } from "../../shared/index.js";
import { AppError } from "../../utils/app-error.js";
import { ok } from "../../utils/response.js";
import { audit } from "../audit/audit.service.js";

// Tambah akun massal dari Excel: unduh template → isi → unggah (pratinjau dulu, lalu buat).
export const userImportRoutes = Router();

const MAX_ROWS = 500;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });

// Kolom template; "*" = wajib. Urutan ini juga yang dibaca saat impor (dicocokkan lewat nama header).
const COLUMNS = [
  { key: "name", header: "Nama*", width: 28, note: "Nama lengkap" },
  { key: "email", header: "Email*", width: 30, note: "Dipakai untuk login, harus unik" },
  { key: "role", header: "Role", width: 18, note: "Kosong = Anggota" },
  { key: "division", header: "Divisi", width: 22, note: "Nama divisi periode aktif" },
  { key: "position", header: "Jabatan", width: 22, note: "Opsional, mis. Staf Media" },
  { key: "password", header: "Password", width: 18, note: "Kosong = dibuat otomatis (min. 8 karakter)" },
  { key: "nim", header: "NIM", width: 16, note: "" },
  { key: "phone", header: "No HP", width: 16, note: "" },
  { key: "campus", header: "Kampus", width: 24, note: "" },
  { key: "major", header: "Jurusan", width: 22, note: "" },
  { key: "batch", header: "Angkatan", width: 12, note: "" },
] as const;
type Key = (typeof COLUMNS)[number]["key"];

const norm = (s: unknown) => String(s ?? "").replace(/\*/g, "").trim().toLowerCase();

async function lookups() {
  const [roles, divisions] = await Promise.all([
    prisma.role.findMany({ select: { id: true, key: true, name: true } }),
    prisma.division.findMany({ where: { period: { isActive: true } }, select: { id: true, name: true, slug: true }, orderBy: { name: "asc" } }),
  ]);
  return { roles, divisions };
}

userImportRoutes.get("/users/import/template", auth, requirePermission("user.manage"), async (_req, res) => {
  const { roles, divisions } = await lookups();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Anggota", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF11418B" } };
  COLUMNS.forEach((c, i) => { if (c.note) head.getCell(i + 1).note = c.note; });

  // Daftar pilihan untuk dropdown Role & Divisi.
  const ref = wb.addWorksheet("Daftar pilihan");
  ref.columns = [{ header: "Role", key: "role", width: 24 }, { header: "Divisi", key: "division", width: 28 }];
  ref.getRow(1).font = { bold: true };
  const assignable = roles.filter((r) => r.key !== "SYS_ADMIN");
  for (let i = 0; i < Math.max(assignable.length, divisions.length); i++) ref.addRow({ role: assignable[i]?.name ?? null, division: divisions[i]?.name ?? null });
  for (let r = 2; r <= MAX_ROWS + 1; r++) {
    ws.getCell(r, 3).dataValidation = { type: "list", allowBlank: true, formulae: [`'Daftar pilihan'!$A$2:$A$${assignable.length + 1}`] };
    if (divisions.length) ws.getCell(r, 4).dataValidation = { type: "list", allowBlank: true, formulae: [`'Daftar pilihan'!$B$2:$B$${divisions.length + 1}`] };
  }

  const ex = wb.addWorksheet("Contoh");
  ex.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  ex.getRow(1).font = { bold: true };
  ex.addRow({ name: "Budi Santoso", email: "budi@email.com", role: "Anggota", division: divisions[0]?.name ?? "Media", position: "Staf", nim: "2201001", phone: "0812xxxx", campus: "Politeknik Negeri Batam", major: "Teknik Informatika", batch: "2022" });
  ex.addRow({ name: "Sari Dewi", email: "sari@email.com", role: "Kepala Divisi", division: divisions[0]?.name ?? "Media", password: "rahasia123" });
  ex.addRow([]);
  ex.addRow(["Catatan: isi data di sheet \"Anggota\". Sheet contoh ini tidak ikut diimpor."]);

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="template-import-anggota.xlsx"');
  await wb.xlsx.write(res);
  res.end();
});

type Result = { row: number; name: string; email: string; role: string; division: string | null; status: "ok" | "error" | "created"; message?: string; password?: string };

// ?dryRun=1 → hanya periksa. Tanpa dryRun → buat akun untuk baris yang valid, baris bermasalah dilewati.
userImportRoutes.post("/users/import", auth, requirePermission("user.manage"), (req, res, next) => {
  upload.single("file")(req, res, (err) => (err ? next(new AppError("UPLOAD_INVALID", 400, err.code === "LIMIT_FILE_SIZE" ? "File maksimal 2 MB" : "Upload gagal")) : next()));
}, async (req, res) => {
  if (!req.file) throw new AppError("VALIDATION", 400, "Pilih file Excel (.xlsx)");
  const dryRun = req.query.dryRun === "1";
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(req.file.buffer as unknown as ArrayBuffer);
  } catch {
    throw new AppError("VALIDATION", 400, "File bukan Excel .xlsx yang valid. Gunakan template yang disediakan.");
  }
  const ws = wb.getWorksheet("Anggota") ?? wb.worksheets[0];
  if (!ws) throw new AppError("VALIDATION", 400, "Sheet kosong");

  // Peta header → kolom (boleh urutan berbeda, cocokkan nama header).
  const colOf = new Map<Key, number>();
  ws.getRow(1).eachCell((cell, col) => {
    const c = COLUMNS.find((x) => norm(x.header) === norm(cell.text));
    if (c) colOf.set(c.key, col);
  });
  if (!colOf.has("name") || !colOf.has("email")) throw new AppError("VALIDATION", 400, "Kolom Nama dan Email tidak ditemukan. Gunakan template yang disediakan.");

  const raw: { row: number; v: Record<Key, string> }[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const v = Object.fromEntries(COLUMNS.map((c) => [c.key, colOf.has(c.key) ? row.getCell(colOf.get(c.key)!).text.trim() : ""])) as Record<Key, string>;
    if (Object.values(v).some(Boolean)) raw.push({ row: n, v });
  });
  if (!raw.length) throw new AppError("VALIDATION", 400, "Belum ada data di sheet Anggota");
  if (raw.length > MAX_ROWS) throw new AppError("VALIDATION", 400, `Maksimal ${MAX_ROWS} baris sekali impor`);

  const { roles, divisions } = await lookups();
  const emails = raw.map((r) => r.v.email.toLowerCase()).filter(Boolean);
  const taken = new Set((await prisma.user.findMany({ where: { email: { in: emails } }, select: { email: true } })).map((u) => u.email.toLowerCase()));
  const seen = new Set<string>();

  const checked = raw.map(({ row, v }) => {
    const base: Result = { row, name: v.name, email: v.email.toLowerCase(), role: "Anggota", division: v.division || null, status: "ok" };
    const fail = (message: string): Result & { data?: undefined } => ({ ...base, status: "error", message });
    const role = v.role ? roles.find((r) => norm(r.key) === norm(v.role) || norm(r.name) === norm(v.role)) : roles.find((r) => r.key === "ANGGOTA");
    if (!role) return fail(`Role "${v.role}" tidak dikenal`);
    base.role = role.name;
    if (role.key === "SYS_ADMIN" && req.user!.role !== "SYS_ADMIN") return fail("Hanya admin yang bisa membuat admin");
    const division = v.division ? divisions.find((d) => norm(d.name) === norm(v.division) || norm(d.slug) === norm(v.division)) : null;
    if (v.division && !division) return fail(`Divisi "${v.division}" tidak ada di periode aktif`);
    if (role.key === "KADIV" && !division) return fail("Kepala Divisi wajib punya divisi");
    const parsed = createUserSchema.safeParse({
      name: v.name, email: v.email, password: v.password || "x".repeat(8), roleKey: role.key as RoleKey, divisionId: division?.id ?? null,
      position: v.position || undefined, nim: v.nim || null, phone: v.phone || null, campus: v.campus || null, major: v.major || null, batch: v.batch || null,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = { name: "Nama", email: "Email", password: "Password" }[String(issue.path[0])] ?? String(issue.path[0]);
      return fail(`${field}: ${issue.path[0] === "email" ? "format email tidak valid" : issue.path[0] === "password" ? "minimal 8 karakter" : issue.message}`);
    }
    if (taken.has(base.email)) return fail("Email sudah terdaftar");
    if (seen.has(base.email)) return fail("Email dobel di file ini");
    seen.add(base.email);
    return { ...base, data: { ...parsed.data, password: v.password || null, roleId: role.id } };
  });

  const valid = checked.filter((r) => r.status === "ok") as (Result & { data: NonNullable<(typeof checked)[number]["data"]> })[];
  const summary = { total: checked.length, valid: valid.length, invalid: checked.length - valid.length, created: 0 };
  if (dryRun || !valid.length) return ok(res, { summary, rows: checked.map(({ data: _d, ...r }) => r as Result) });

  // Buat akun (hash password paralel per 10 supaya cepat tanpa membebani CPU).
  const out = new Map<number, Result>();
  for (let i = 0; i < valid.length; i += 10) {
    await Promise.all(valid.slice(i, i + 10).map(async (r) => {
      const { password, roleId, roleKey: _rk, divisionId, position, ...data } = r.data;
      const plain = password ?? crypto.randomBytes(6).toString("base64url"); // 8 karakter acak
      try {
        await prisma.$transaction(async (tx) => {
          const u = await tx.user.create({ data: { ...data, email: data.email.toLowerCase(), passwordHash: await bcrypt.hash(plain, 10) } });
          await tx.membership.create({ data: { userId: u.id, periodId: req.user!.periodId, roleId, divisionId: divisionId ?? null, position } });
        });
        // Password hanya dikembalikan kalau dibuat otomatis (yang diisi di Excel sudah diketahui pengunggah).
        out.set(r.row, { ...r, status: "created", ...(password ? {} : { password: plain }) });
      } catch (e) {
        out.set(r.row, { ...r, status: "error", message: (e as { code?: string }).code === "P2002" ? "Email sudah terdaftar" : "Gagal dibuat" });
      }
    }));
  }
  summary.created = [...out.values()].filter((r) => r.status === "created").length;
  await audit(req, "user.import", "User", null, null, { created: summary.created, emails: [...out.values()].filter((r) => r.status === "created").map((r) => r.email) });
  const strip = ({ data: _d, ...r }: Result & { data?: unknown }): Result => r;
  ok(res, { summary, rows: checked.map((r) => strip(out.get(r.row) ?? r)) });
});
