import { prisma } from "../../lib/prisma.js";
import type { AuthUser } from "../../middlewares/auth.js";
import { AppError } from "../../utils/app-error.js";
import { usersWithPermission } from "../notifications/notifications.service.js";

// Kas = pemilik uang. null = kas organisasi (Bendahara, finance.manage); selain itu id divisi (kas divisi:
// dikelola Kadiv divisi itu atau anggota yang diberi akses "Kas divisi"). Query/URL memakai ?kas=org|<divisionId>.
export type Treasury = string | null;

export const treasuryOf = (v: unknown): Treasury => (typeof v === "string" && v && v !== "org" ? v : null);

export const canManageTreasury = (u: AuthUser, t: Treasury) =>
  t === null ? u.permissions.has("finance.manage") : u.divisionId === t && (u.role === "KADIV" || u.divisionGrants.has("finance"));

// Pengurus dengan finance.read (Ketum, Sekretaris, Bendahara…) boleh memantau semua kas.
export const canReadTreasury = (u: AuthUser, t: Treasury) => canManageTreasury(u, t) || u.permissions.has("finance.read");

export function assertTreasury(u: AuthUser, t: Treasury, mode: "read" | "manage") {
  if (!(mode === "manage" ? canManageTreasury(u, t) : canReadTreasury(u, t))) {
    throw new AppError("FORBIDDEN", 403, t === null ? "Hanya Bendahara yang bisa mengelola kas organisasi" : "Hanya pengelola kas divisi ini yang bisa melakukannya");
  }
}

// Penerima notifikasi bukti bayar baru.
export async function treasuryManagers(t: Treasury): Promise<string[]> {
  if (t === null) return usersWithPermission("finance.manage");
  const [heads, grants] = await Promise.all([
    prisma.membership.findMany({ where: { divisionId: t, period: { isActive: true }, role: { key: "KADIV" }, user: { status: "ACTIVE", deletedAt: null } }, select: { userId: true } }),
    prisma.divisionGrant.findMany({ where: { divisionId: t, area: "finance" }, select: { userId: true } }),
  ]);
  return [...new Set([...heads, ...grants].map((x) => x.userId))];
}
