import * as cheerio from "cheerio";
import { prisma } from "../../lib/prisma.js";

// Indikator ekonomi dari beranda bi.go.id (diadaptasi dari skrip scrape-bi.mjs).
// Di halaman BI, tiap kotak indikator tersusun: NILAI → LABEL → PERIODE.
const SOURCE = "https://www.bi.go.id/id/default.aspx";
const SLUG = "bi-indikator"; // hasil terakhir disimpan di tabel Page supaya tetap tampil saat bi.go.id down
const MAX_AGE_MS = 6 * 3_600_000;

export type Indicator = { key: string; label: string; value: string; period: string | null };
export type Indicators = { updatedAt: string; source: string; items: Indicator[] };

const PERCENT = /^-?\d+(,\d+)?%$/;

const LABELS: { key: string; label: string; re: RegExp; format: (raw: string) => string | null }[] = [
  { key: "bi_rate", label: "BI-Rate", re: /^BI-?Rate$/i, format: (v) => (PERCENT.test(v) ? v : null) },
  { key: "inflasi", label: "Inflasi IHK (yoy)", re: /^Inflasi IHK/i, format: (v) => (PERCENT.test(v) ? v : null) },
  { key: "target_inflasi", label: "Target inflasi", re: /^Target Inflasi$/i, format: (v) => (/^\d+(,\d+)?±\d+(,\d+)?%$/.test(v) ? v : null) },
  {
    key: "cadangan_devisa",
    label: "Cadangan devisa (miliar US$)",
    re: /^Cadangan Devisa/i,
    // "$ 146.765" (juta USD) → "146,8" (miliar); satuan di label supaya angka tidak terpotong di layar kecil
    format: (v) => (/^\$\s?\d{1,3}(\.\d{3})+$/.test(v) ? (Number(v.replace(/\D/g, "")) / 1000).toLocaleString("id-ID", { maximumFractionDigits: 1 }) : null),
  },
  { key: "jisdor", label: "Kurs JISDOR (USD/IDR)", re: /^JISDOR \(USD/i, format: (v) => (/^Rp\s?\d{1,3}(\.\d{3})+$/.test(v) ? v.replace(/\s/g, "") : null) },
];

const PERIOD = /^(\d{1,2}\s+)?(Jan|Feb|Mar|Apr|Mei|Jun|Jul|Agu|Sep|Okt|Nov|Des)[a-z]*\s+\d{4}$|^\d{4}$/i;

// Murni (tanpa jaringan) supaya bisa dites dengan teks halaman tersimpan.
export function parseIndicators(lines: string[]): Indicator[] {
  const items: Indicator[] = [];
  for (const L of LABELS) {
    // Label juga muncul di menu navigasi; ambil kemunculan yang baris sebelumnya berupa nilai valid.
    for (let i = 1; i < lines.length; i++) {
      if (!L.re.test(lines[i])) continue;
      const value = L.format(lines[i - 1]);
      if (!value) continue;
      items.push({ key: L.key, label: L.label, value, period: PERIOD.test(lines[i + 1] ?? "") ? lines[i + 1] : null });
      break;
    }
  }
  return items;
}

export function pageLines(html: string) {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  $("br, p, div, li, tr, td, th, span, h1, h2, h3, h4, h5, a").each((_, el) => {
    $(el).append("\n");
  });
  return $("body")
    .text()
    .split("\n")
    .map((s) => s.replace(/[​-‍﻿]/g, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

async function scrape(): Promise<Indicators> {
  const res = await fetch(SOURCE, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; GenBI-Platform/1.0)", Accept: "text/html", "Accept-Language": "id-ID,id;q=0.9" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`bi.go.id HTTP ${res.status}`);
  const items = parseIndicators(pageLines(await res.text()));
  // Tata letak BI berubah → jangan timpa data lama yang masih benar dengan hasil setengah kosong.
  if (items.length < 3) throw new Error(`bi.go.id: hanya ${items.length} indikator terbaca, tata letak mungkin berubah`);
  return { updatedAt: new Date().toISOString(), source: SOURCE, items };
}

let refreshing: Promise<unknown> | null = null;

export function refreshIndicators() {
  refreshing ??= scrape()
    .then((data) => prisma.page.upsert({ where: { slug: SLUG }, update: { contentJson: data }, create: { slug: SLUG, title: "Indikator BI", contentJson: data } }))
    .catch((e) => console.error("indikator BI gagal diperbarui:", e.message))
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

// Kembalikan data tersimpan secepatnya; kalau sudah basi, perbarui di belakang layar.
export async function getIndicators(): Promise<Indicators | null> {
  const stored = async () => ((await prisma.page.findUnique({ where: { slug: SLUG } }))?.contentJson as Indicators | null | undefined) ?? null;
  const data = await stored();
  if (!data) {
    await refreshIndicators();
    return stored();
  }
  if (Date.now() - new Date(data.updatedAt).getTime() > MAX_AGE_MS) void refreshIndicators();
  return data;
}
