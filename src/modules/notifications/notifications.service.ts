import { prisma, type Prisma } from "../../lib/prisma.js";
import type { PermissionKey } from "../../shared/index.js";

type Db = Prisma.TransactionClient | typeof prisma;
export type Notice = { type: string; title: string; body?: string; link?: string };

// Notifikasi in-app. shortcut: belum kirim push FCM/email; sambungkan di sini saat Firebase siap.
export async function notify(userIds: string[], n: Notice, db: Db = prisma) {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  await db.notification.createMany({ data: ids.map((userId) => ({ userId, type: n.type, title: n.title, body: n.body, data: n.link ? { link: n.link } : undefined })) });
}

// Semua user aktif di periode aktif yang punya permission tertentu (mis. bendahara untuk finance.manage).
export async function usersWithPermission(perm: PermissionKey) {
  const rows = await prisma.membership.findMany({
    where: { period: { isActive: true }, user: { status: "ACTIVE", deletedAt: null }, role: { permissions: { some: { permission: { key: perm } } } } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}
