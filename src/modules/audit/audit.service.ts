import type { Request } from "express";
import { prisma, type Prisma } from "../../lib/prisma.js";

type Db = Prisma.TransactionClient | typeof prisma;

export function audit(
  req: Request,
  action: string,
  entity: string,
  entityId?: string | null,
  before?: unknown,
  after?: unknown,
  db: Db = prisma,
) {
  return db.auditLog.create({
    data: {
      actorId: req.user?.id,
      action,
      entity,
      entityId: entityId ?? undefined,
      before: (before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (after ?? undefined) as Prisma.InputJsonValue | undefined,
      ip: req.ip,
    },
  });
}
