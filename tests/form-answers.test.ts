import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAnswers } from "../src/modules/forms/answers.js";
import type { FormQuestion } from "../src/shared/index.js";

const qs: FormQuestion[] = [
  { id: "nama", type: "SHORT", label: "Nama", required: true },
  { id: "div", type: "CHOICE", label: "Divisi", required: true, options: ["Media", "Humas"] },
  { id: "hari", type: "CHECKBOX", label: "Hari", required: false, options: ["Sabtu", "Minggu"] },
  { id: "umur", type: "NUMBER", label: "Umur", required: false },
  { id: "tgl", type: "DATE", label: "Tanggal", required: false },
];

test("form: jawaban valid dibersihkan, id asing dibuang", () => {
  const r = checkAnswers(qs, { nama: " Ani ", div: "Media", hari: ["Sabtu", "Sabtu"], umur: "20", asing: "x" });
  assert.deepEqual(r, { answers: { nama: "Ani", div: "Media", hari: ["Sabtu"], umur: "20" } });
});

test("form: wajib, opsi di luar daftar, tipe salah ditolak", () => {
  assert.ok("error" in checkAnswers(qs, { div: "Media" })); // nama kosong
  assert.ok("error" in checkAnswers(qs, { nama: "A", div: "Lain" }));
  assert.ok("error" in checkAnswers(qs, { nama: "A", div: "Media", hari: ["Senin"] }));
  assert.ok("error" in checkAnswers(qs, { nama: "A", div: "Media", hari: "Sabtu" }));
  assert.ok("error" in checkAnswers(qs, { nama: "A", div: "Media", umur: "dua" }));
  assert.ok("error" in checkAnswers(qs, { nama: "A", div: "Media", tgl: "kemarin" }));
});

test("form: tema diisi default, warna & gambar header divalidasi", async () => {
  const { formThemeSchema } = await import("../src/shared/index.js");
  assert.deepEqual(formThemeSchema.parse({}), { style: "classic", accent: "#11418b", background: "#f1f5f9", font: "sans", radius: "rounded", showLogo: true });
  assert.equal(formThemeSchema.safeParse({ accent: "red" }).success, false);
  assert.equal(formThemeSchema.safeParse({ coverUrl: "javascript:alert(1)" }).success, false);
  assert.equal(formThemeSchema.safeParse({ coverUrl: "http://x.com/a.png" }).success, false);
  assert.equal(formThemeSchema.safeParse({ coverUrl: "/storage/public/2026/a.webp" }).success, true);
});
