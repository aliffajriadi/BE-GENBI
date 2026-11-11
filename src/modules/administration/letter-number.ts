const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];

// Format nomor surat keluar, contoh: 001/GenBI-KEPRI/XI/2026.
export function letterNumber(seq: number, org: string, date: Date) {
  const local = new Date(date.getTime() + 7 * 3_600_000); // bulan & tahun menurut WIB
  return `${String(seq).padStart(3, "0")}/${org}/${ROMAN[local.getUTCMonth()]}/${local.getUTCFullYear()}`;
}
