import cron from "node-cron";
import { prisma } from "../lib/prisma.js";
import { publishNow } from "../modules/articles/articles.service.js";
import { closeAttendance, scopeUserIds } from "../modules/events/events.service.js";
import { dailyBilling } from "../modules/finance/finance.service.js";
import { refreshFeed } from "../modules/instagram/instagram.service.js";
import { notify } from "../modules/notifications/notifications.service.js";
import { fmtWib } from "../utils/date.js";

const safe = (name: string, fn: () => Promise<unknown>) => () => fn().catch((err) => console.error(`job ${name} gagal`, err));

export function startJobs() {
  // Tiap menit: tutup absensi yang lupa ditutup, tayangkan artikel terjadwal.
  cron.schedule("* * * * *", safe("minutely", async () => {
    const now = new Date();
    for (const e of await prisma.event.findMany({ where: { attendanceStatus: "OPEN", endAt: { lt: now }, deletedAt: null } })) {
      await closeAttendance(e).catch((err) => console.error(`auto-close ${e.id} gagal`, err));
    }
    for (const a of await prisma.article.findMany({ where: { status: "SCHEDULED", scheduledAt: { lte: now }, deletedAt: null }, select: { id: true } })) {
      await publishNow(a.id);
    }
  }));

  // Tiap jam: pengingat kegiatan H-1 dan ±1 jam sebelum mulai.
  cron.schedule("0 * * * *", safe("event-reminder", async () => {
    const now = Date.now();
    const windows = [
      { from: now + 23 * 3_600_000, to: now + 24 * 3_600_000, label: "besok" },
      { from: now + 3_600_000, to: now + 2 * 3_600_000, label: "1 jam lagi" },
    ];
    for (const w of windows) {
      const events = await prisma.event.findMany({ where: { deletedAt: null, startAt: { gte: new Date(w.from), lt: new Date(w.to) } } });
      for (const e of events) {
        await notify(await scopeUserIds(e), { type: "EVENT_REMINDER", title: `${e.title} ${w.label}`, body: `${fmtWib(e.startAt)}${e.location ? ` · ${e.location}` : ""}`, link: `/dashboard/events/${e.id}` });
      }
    }
  }));

  // Tiap hari 07.00 WIB: tagihan kas periode baru, status menunggak, pengingat H-3.
  cron.schedule("0 7 * * *", safe("billing", () => dailyBilling()), { timezone: "Asia/Jakarta" });

  // Tiap 30 menit: simpan ulang profil & postingan Instagram ke database (landing page membaca dari sana).
  cron.schedule("*/30 * * * *", safe("instagram-feed", () => refreshFeed()));
}
