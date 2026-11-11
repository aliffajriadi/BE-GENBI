import { Router } from "express";
import { prisma, type Prisma } from "../../lib/prisma.js";
import { auth, type AuthUser } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import { boardCardSchema, boardColumnSchema, GLOBAL_ROLES, moveCardSchema, updateCardSchema, updateColumnSchema } from "../../shared/index.js";
import { AppError } from "../../utils/app-error.js";
import { ok } from "../../utils/response.js";
import { emitToRoom } from "../chat/chat.service.js";
import { notify } from "../notifications/notifications.service.js";

// Papan planning (kanban) per divisi.
// Lihat: anggota divisi + pengurus inti. Kartu: anggota divisi (kolaboratif). Kolom: Kadiv / akses "planning" / user.manage.
export const planningRoutes = Router();

const DEFAULT_COLUMNS = [
  { name: "To do", isDone: false },
  { name: "Proses", isDone: false },
  { name: "Review", isDone: false },
  { name: "Selesai", isDone: true },
];

export const boardRoom = (divisionId: string) => `board:${divisionId}`;
const changed = (divisionId: string) => emitToRoom(boardRoom(divisionId), "board:changed", { divisionId });

export const canViewBoard = (u: AuthUser, divisionId: string) => u.divisionId === divisionId || GLOBAL_ROLES.includes(u.role);
const canEditCards = (u: AuthUser, divisionId: string) => u.divisionId === divisionId || u.permissions.has("user.manage");
const canManageColumns = (u: AuthUser, divisionId: string) =>
  (u.divisionId === divisionId && (u.role === "KADIV" || u.divisionGrants.has("planning"))) || u.permissions.has("user.manage");

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new AppError("FORBIDDEN", 403, msg);
}

// Papan dibuat otomatis saat pertama dibuka, lengkap dengan kolom bawaan.
async function ensureBoard(divisionId: string) {
  const found = await prisma.board.findUnique({ where: { divisionId } });
  if (found) return found;
  if (!(await prisma.division.findUnique({ where: { id: divisionId } }))) throw new AppError("NOT_FOUND", 404, "Divisi tidak ditemukan");
  try {
    return await prisma.board.create({ data: { divisionId, columns: { create: DEFAULT_COLUMNS.map((c, position) => ({ ...c, position })) } } });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return prisma.board.findUniqueOrThrow({ where: { divisionId } }); // dibuat bersamaan
    throw e;
  }
}

async function assertMember(divisionId: string, userId: string | null | undefined) {
  if (!userId) return;
  const m = await prisma.membership.count({ where: { userId, divisionId, period: { isActive: true }, user: { status: "ACTIVE", deletedAt: null } } });
  if (!m) throw new AppError("VALIDATION", 400, "PIC harus anggota aktif divisi ini");
}

async function cardWithBoard(id: string) {
  const c = await prisma.boardCard.findUnique({ where: { id }, include: { board: true } });
  if (!c) throw new AppError("NOT_FOUND", 404, "Kartu tidak ditemukan");
  return c;
}

async function columnWithBoard(id: string) {
  const c = await prisma.boardColumn.findUnique({ where: { id }, include: { board: true } });
  if (!c) throw new AppError("NOT_FOUND", 404, "Kolom tidak ditemukan");
  return c;
}

// Atur ulang urutan (0..n) setelah menyisipkan `id` di posisi `index`.
function reorder<T extends { id: string }>(items: T[], id: string, index: number) {
  const list = items.filter((x) => x.id !== id);
  list.splice(Math.min(index, list.length), 0, { id } as T);
  return list.map((x, position) => ({ id: x.id, position }));
}

planningRoutes.get("/boards", auth, async (req, res) => {
  const u = req.user!;
  const divisions = await prisma.division.findMany({
    where: { period: { isActive: true }, ...(GLOBAL_ROLES.includes(u.role) ? {} : { id: u.divisionId ?? "__none__" }) },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  ok(res, divisions);
});

planningRoutes.get("/boards/:divisionId", auth, async (req, res) => {
  const u = req.user!;
  const divisionId = String(req.params.divisionId);
  assert(canViewBoard(u, divisionId), "Papan ini hanya untuk anggota divisinya");
  const board = await ensureBoard(divisionId);
  const [division, columns, cards, members] = await Promise.all([
    prisma.division.findUniqueOrThrow({ where: { id: divisionId }, select: { id: true, name: true } }),
    prisma.boardColumn.findMany({ where: { boardId: board.id }, orderBy: { position: "asc" } }),
    prisma.boardCard.findMany({ where: { boardId: board.id }, orderBy: { position: "asc" }, include: { assignee: { select: { id: true, name: true, avatarUrl: true } } } }),
    prisma.user.findMany({
      where: { status: "ACTIVE", deletedAt: null, memberships: { some: { divisionId, period: { isActive: true } } } },
      select: { id: true, name: true, avatarUrl: true },
      orderBy: { name: "asc" },
    }),
  ]);
  ok(res, { division, columns, cards, members, canEdit: canEditCards(u, divisionId), canManage: canManageColumns(u, divisionId) });
});

// ───── Kolom ─────

planningRoutes.post("/boards/:divisionId/columns", auth, validate(boardColumnSchema), async (req, res) => {
  const divisionId = String(req.params.divisionId);
  assert(canManageColumns(req.user!, divisionId), "Hanya kepala divisi (atau yang diberi akses) yang bisa mengatur kolom");
  const board = await ensureBoard(divisionId);
  const count = await prisma.boardColumn.count({ where: { boardId: board.id } });
  if (count >= 12) throw new AppError("VALIDATION", 400, "Maksimal 12 kolom");
  const col = await prisma.boardColumn.create({ data: { boardId: board.id, name: req.body.name, position: count } });
  changed(divisionId);
  ok(res, col, undefined, 201);
});

planningRoutes.patch("/board-columns/:id", auth, validate(updateColumnSchema), async (req, res) => {
  const col = await columnWithBoard(String(req.params.id));
  assert(canManageColumns(req.user!, col.board.divisionId), "Hanya kepala divisi (atau yang diberi akses) yang bisa mengatur kolom");
  const { position, ...data } = req.body as { name?: string; isDone?: boolean; position?: number };
  await prisma.$transaction(async (tx) => {
    if (Object.keys(data).length) await tx.boardColumn.update({ where: { id: col.id }, data });
    if (position != null) {
      const all = await tx.boardColumn.findMany({ where: { boardId: col.boardId }, orderBy: { position: "asc" }, select: { id: true } });
      for (const x of reorder(all, col.id, position)) await tx.boardColumn.update({ where: { id: x.id }, data: { position: x.position } });
    }
  });
  changed(col.board.divisionId);
  ok(res, { id: col.id });
});

planningRoutes.delete("/board-columns/:id", auth, async (req, res) => {
  const col = await columnWithBoard(String(req.params.id));
  assert(canManageColumns(req.user!, col.board.divisionId), "Hanya kepala divisi (atau yang diberi akses) yang bisa mengatur kolom");
  if (await prisma.boardCard.count({ where: { columnId: col.id } })) throw new AppError("VALIDATION", 400, "Kolom masih berisi kartu. Pindahkan atau hapus kartunya dulu.");
  if ((await prisma.boardColumn.count({ where: { boardId: col.boardId } })) <= 1) throw new AppError("VALIDATION", 400, "Papan minimal punya satu kolom");
  await prisma.boardColumn.delete({ where: { id: col.id } });
  changed(col.board.divisionId);
  ok(res, null);
});

// ───── Kartu ─────

planningRoutes.post("/boards/:divisionId/cards", auth, validate(boardCardSchema), async (req, res) => {
  const u = req.user!;
  const divisionId = String(req.params.divisionId);
  assert(canEditCards(u, divisionId), "Hanya anggota divisi ini yang bisa menambah kartu");
  const board = await ensureBoard(divisionId);
  const col = await prisma.boardColumn.findFirst({ where: { id: req.body.columnId, boardId: board.id } });
  if (!col) throw new AppError("VALIDATION", 400, "Kolom tidak ada di papan ini");
  await assertMember(divisionId, req.body.assigneeId);
  const last = await prisma.boardCard.aggregate({ where: { columnId: col.id }, _max: { position: true } });
  const card = await prisma.boardCard.create({
    data: { ...req.body, boardId: board.id, position: (last._max.position ?? -1) + 1, createdById: u.id },
  });
  if (card.assigneeId && card.assigneeId !== u.id) await notify([card.assigneeId], { type: "PLANNING_ASSIGNED", title: "Kamu jadi PIC kartu baru", body: card.title, link: "/dashboard/planning" });
  changed(divisionId);
  ok(res, card, undefined, 201);
});

planningRoutes.patch("/board-cards/:id", auth, validate(updateCardSchema), async (req, res) => {
  const u = req.user!;
  const card = await cardWithBoard(String(req.params.id));
  assert(canEditCards(u, card.board.divisionId), "Hanya anggota divisi ini yang bisa mengubah kartu");
  if (req.body.assigneeId !== undefined) await assertMember(card.board.divisionId, req.body.assigneeId);
  const updated = await prisma.boardCard.update({ where: { id: card.id }, data: req.body as Prisma.BoardCardUncheckedUpdateInput });
  if (updated.assigneeId && updated.assigneeId !== card.assigneeId && updated.assigneeId !== u.id) {
    await notify([updated.assigneeId], { type: "PLANNING_ASSIGNED", title: "Kamu jadi PIC kartu", body: updated.title, link: "/dashboard/planning" });
  }
  changed(card.board.divisionId);
  ok(res, updated);
});

planningRoutes.post("/board-cards/:id/move", auth, validate(moveCardSchema), async (req, res) => {
  const card = await cardWithBoard(String(req.params.id));
  assert(canEditCards(req.user!, card.board.divisionId), "Hanya anggota divisi ini yang bisa memindahkan kartu");
  const col = await prisma.boardColumn.findFirst({ where: { id: req.body.columnId, boardId: card.boardId } });
  if (!col) throw new AppError("VALIDATION", 400, "Kolom tidak ada di papan ini");
  await prisma.$transaction(async (tx) => {
    await tx.boardCard.update({ where: { id: card.id }, data: { columnId: col.id } });
    const all = await tx.boardCard.findMany({ where: { columnId: col.id }, orderBy: { position: "asc" }, select: { id: true } });
    for (const x of reorder(all, card.id, req.body.index)) await tx.boardCard.update({ where: { id: x.id }, data: { position: x.position } });
  });
  changed(card.board.divisionId);
  ok(res, { id: card.id, columnId: col.id });
});

planningRoutes.delete("/board-cards/:id", auth, async (req, res) => {
  const u = req.user!;
  const card = await cardWithBoard(String(req.params.id));
  assert(card.createdById === u.id || canManageColumns(u, card.board.divisionId), "Hanya pembuat kartu atau kepala divisi yang bisa menghapus");
  await prisma.boardCard.delete({ where: { id: card.id } });
  changed(card.board.divisionId);
  ok(res, null);
});
