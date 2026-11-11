// Seed: role, permission, periode aktif, aturan poin awal, akun sys admin. Aman dijalankan ulang.
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { DEFAULT_POINT_RULES, PERMISSIONS, ROLE_PERMISSIONS, ROLES } from "../src/shared/index.js";

const prisma = new PrismaClient();

const ROLE_NAMES: Record<string, string> = {
  SYS_ADMIN: "System Administrator",
  KETUM: "Ketua Umum",
  SEKRETARIS: "Sekretaris",
  BENDAHARA: "Bendahara",
  KADIV: "Kepala Divisi",
  ANGGOTA: "Anggota",
};

async function main() {
  for (const [key, label] of Object.entries(PERMISSIONS)) {
    await prisma.permission.upsert({ where: { key }, update: { label }, create: { key, label } });
  }
  const perms = await prisma.permission.findMany();
  const permId = new Map(perms.map((p) => [p.key, p.id]));

  for (const key of ROLES) {
    const role = await prisma.role.upsert({ where: { key }, update: {}, create: { key, name: ROLE_NAMES[key] } });
    // Hanya isi permission default kalau role belum punya — supaya perubahan dari panel tidak ditimpa.
    if ((await prisma.rolePermission.count({ where: { roleId: role.id } })) === 0) {
      await prisma.rolePermission.createMany({
        data: ROLE_PERMISSIONS[key].map((p) => ({ roleId: role.id, permissionId: permId.get(p)! })),
      });
    }
  }

  for (const r of DEFAULT_POINT_RULES) {
    await prisma.pointRule.upsert({ where: { key: r.key }, update: {}, create: { ...r } });
  }

  let period = await prisma.period.findFirst({ where: { isActive: true } });
  if (!period) {
    const y = new Date().getFullYear();
    period = await prisma.period.create({
      data: { name: `${y}/${y + 1}`, startDate: new Date(`${y}-01-01`), endDate: new Date(`${y + 1}-01-01`), isActive: true },
    });
  }

  const email = process.env.SEED_ADMIN_EMAIL ?? "admin@genbi.local";
  const password = process.env.SEED_ADMIN_PASSWORD ?? "admin12345";
  const admin = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name: "System Administrator", passwordHash: await bcrypt.hash(password, 10) },
  });
  const sysRole = await prisma.role.findUniqueOrThrow({ where: { key: "SYS_ADMIN" } });
  await prisma.membership.upsert({
    where: { userId_periodId: { userId: admin.id, periodId: period.id } },
    update: {},
    create: { userId: admin.id, periodId: period.id, roleId: sysRole.id, position: "System Administrator" },
  });

  console.log(`Seed selesai. Login: ${email} / ${password} (segera ganti).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
