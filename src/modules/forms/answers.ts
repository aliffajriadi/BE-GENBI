import type { FormQuestion } from "../../shared/index.js";

type Answer = string | string[];

// Cocokkan jawaban dengan definisi pertanyaan. Mengembalikan jawaban yang sudah dibersihkan,
// atau pesan error pertama. ID pertanyaan yang tidak dikenal dibuang.
export function checkAnswers(questions: FormQuestion[], input: Record<string, Answer>): { answers: Record<string, Answer> } | { error: string } {
  const out: Record<string, Answer> = {};
  for (const q of questions) {
    const raw = input[q.id];
    const empty = raw == null || (Array.isArray(raw) ? raw.length === 0 : raw.trim() === "");
    if (empty) {
      if (q.required) return { error: `"${q.label}" wajib diisi` };
      continue;
    }
    const opts = q.options ?? [];
    if (q.type === "CHECKBOX") {
      if (!Array.isArray(raw)) return { error: `Jawaban "${q.label}" tidak valid` };
      const picked = [...new Set(raw)];
      if (picked.some((v) => !opts.includes(v))) return { error: `Pilihan "${q.label}" tidak valid` };
      out[q.id] = picked;
      continue;
    }
    if (typeof raw !== "string") return { error: `Jawaban "${q.label}" tidak valid` };
    const v = raw.trim();
    if (q.type === "SHORT" && v.length > 500) return { error: `"${q.label}" maksimal 500 karakter` };
    if ((q.type === "CHOICE" || q.type === "DROPDOWN") && !opts.includes(v)) return { error: `Pilihan "${q.label}" tidak valid` };
    if (q.type === "NUMBER" && !Number.isFinite(Number(v))) return { error: `"${q.label}" harus berupa angka` };
    if (q.type === "DATE" && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v)))) return { error: `"${q.label}" harus berupa tanggal` };
    out[q.id] = v;
  }
  return { answers: out };
}
