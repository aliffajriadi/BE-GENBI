import { Router, type RequestHandler } from "express";
import { prisma, type Prisma } from "../../lib/prisma.js";
import { auth, requirePermission, type AuthUser } from "../../middlewares/auth.js";
import { formLimiter } from "../../middlewares/rate-limit.js";
import { validate } from "../../middlewares/validate.js";
import { formSchema, formSubmitSchema, updateFormSchema, type FormQuestion } from "../../shared/index.js";
import { AppError } from "../../utils/app-error.js";
import { ok } from "../../utils/response.js";
import { audit } from "../audit/audit.service.js";
import { checkAnswers } from "./answers.js";

// Form ala Google Form. Buat: yang boleh membuat kegiatan (Kadiv & pengurus inti) atau admin.
// Kelola & lihat respons: pembuat form atau admin.manage. Isi: lewat /f/<slug> (publik atau wajib login).
export const formsRoutes = Router();

const canCreate = requirePermission("event.create", "admin.manage");
const canManage = (u: AuthUser, createdById: string) => createdById === u.id || u.permissions.has("admin.manage");
const taken = (e: unknown) => (e as { code?: string }).code === "P2002";
// Login opsional: form publik bisa diisi tanpa token, form anggota butuh token.
const maybeAuth: RequestHandler = (req, res, next) => (req.headers.authorization ? auth(req, res, next) : next());
const isOpen = (f: { isOpen: boolean; closesAt: Date | null }) => f.isOpen && (!f.closesAt || f.closesAt > new Date());

async function managed(u: AuthUser, id: string) {
  const f = await prisma.form.findUnique({ where: { id }, include: { _count: { select: { responses: true } } } });
  if (!f) throw new AppError("NOT_FOUND", 404, "Form tidak ditemukan");
  if (!canManage(u, f.createdById)) throw new AppError("FORBIDDEN", 403, "Hanya pembuat form atau admin yang bisa mengelola");
  return f;
}

// ───── Kelola ─────

formsRoutes.get("/forms", auth, canCreate, async (req, res) => {
  const u = req.user!;
  const rows = await prisma.form.findMany({
    where: u.permissions.has("admin.manage") ? {} : { createdById: u.id },
    orderBy: { updatedAt: "desc" },
    select: { id: true, slug: true, title: true, audience: true, isOpen: true, closesAt: true, updatedAt: true, createdBy: { select: { name: true } }, _count: { select: { responses: true } } },
  });
  ok(res, rows);
});

formsRoutes.post("/forms", auth, canCreate, validate(formSchema), async (req, res) => {
  try {
    const f = await prisma.form.create({ data: { ...req.body, createdById: req.user!.id } });
    await audit(req, "form.create", "Form", f.id, null, { slug: f.slug, title: f.title });
    ok(res, f, undefined, 201);
  } catch (e) {
    if (taken(e)) throw new AppError("CONFLICT", 409, "Slug sudah dipakai, pilih yang lain");
    throw e;
  }
});

formsRoutes.get("/forms/:id", auth, async (req, res) => {
  ok(res, await managed(req.user!, String(req.params.id)));
});

formsRoutes.patch("/forms/:id", auth, validate(updateFormSchema), async (req, res) => {
  const f = await managed(req.user!, String(req.params.id));
  // Jawaban lama mengacu ke ID & opsi pertanyaan, jadi pertanyaan dikunci begitu ada respons.
  if (req.body.questions && f._count.responses > 0) throw new AppError("VALIDATION", 400, "Pertanyaan terkunci karena form sudah punya respons");
  try {
    const updated = await prisma.form.update({ where: { id: f.id }, data: req.body });
    await audit(req, "form.update", "Form", f.id, null, { slug: updated.slug, title: updated.title });
    ok(res, updated);
  } catch (e) {
    if (taken(e)) throw new AppError("CONFLICT", 409, "Slug sudah dipakai, pilih yang lain");
    throw e;
  }
});

formsRoutes.delete("/forms/:id", auth, async (req, res) => {
  const f = await managed(req.user!, String(req.params.id));
  await prisma.form.delete({ where: { id: f.id } });
  await audit(req, "form.delete", "Form", f.id, { slug: f.slug, title: f.title, responses: f._count.responses }, null);
  ok(res, null);
});

// shortcut: semua respons dikirim sekaligus; tambah paginasi kalau satu form rutin lewat ~5.000 respons.
formsRoutes.get("/forms/:id/responses", auth, async (req, res) => {
  const f = await managed(req.user!, String(req.params.id));
  ok(res, await prisma.formResponse.findMany({ where: { formId: f.id }, orderBy: { createdAt: "asc" }, include: { user: { select: { id: true, name: true, email: true } } } }));
});

formsRoutes.delete("/form-responses/:id", auth, async (req, res) => {
  const r = await prisma.formResponse.findUnique({ where: { id: String(req.params.id) }, include: { form: { select: { createdById: true } } } });
  if (!r) throw new AppError("NOT_FOUND", 404, "Respons tidak ditemukan");
  if (!canManage(req.user!, r.form.createdById)) throw new AppError("FORBIDDEN", 403, "Hanya pembuat form atau admin yang bisa menghapus respons");
  await prisma.formResponse.delete({ where: { id: r.id } });
  await audit(req, "form.response.delete", "FormResponse", r.id, r, null);
  ok(res, null);
});

// ───── Isi (publik) ─────

async function bySlug(slug: string) {
  const f = await prisma.form.findUnique({ where: { slug: slug.toLowerCase() } });
  if (!f) throw new AppError("NOT_FOUND", 404, "Form tidak ditemukan");
  return f;
}

formsRoutes.get("/public/forms/:slug", maybeAuth, async (req, res) => {
  const f = await bySlug(String(req.params.slug));
  const submitted = req.user && f.audience === "MEMBERS" && f.onePerUser ? (await prisma.formResponse.count({ where: { formId: f.id, userId: req.user.id } })) > 0 : false;
  ok(res, {
    title: f.title, description: f.description, questions: f.questions, audience: f.audience, closesAt: f.closesAt, theme: f.theme,
    open: isOpen(f), loggedIn: !!req.user, submitted,
  });
});

formsRoutes.post("/public/forms/:slug/responses", formLimiter, maybeAuth, validate(formSubmitSchema), async (req, res) => {
  const f = await bySlug(String(req.params.slug));
  if (req.body.website) return ok(res, null, undefined, 201); // honeypot terisi: anggap sukses, jangan simpan
  if (!isOpen(f)) throw new AppError("FORM_CLOSED", 400, "Form ini sudah ditutup");
  if (f.audience === "MEMBERS" && !req.user) throw new AppError("UNAUTHENTICATED", 401, "Silakan login untuk mengisi form ini");
  const userId = f.audience === "MEMBERS" ? req.user!.id : null;
  if (userId && f.onePerUser && (await prisma.formResponse.count({ where: { formId: f.id, userId } }))) throw new AppError("CONFLICT", 409, "Kamu sudah mengisi form ini");
  const result = checkAnswers(f.questions as FormQuestion[], req.body.answers);
  if ("error" in result) throw new AppError("VALIDATION", 400, result.error);
  await prisma.formResponse.create({ data: { formId: f.id, userId, answers: result.answers as Prisma.InputJsonObject } });
  ok(res, null, undefined, 201);
});
