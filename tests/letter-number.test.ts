import assert from "node:assert/strict";
import { it } from "node:test";
import { letterNumber } from "../src/modules/administration/letter-number.js";

it("nomor surat keluar", () => {
  assert.equal(letterNumber(1, "GenBI-KEPRI", new Date("2026-11-09T03:00:00Z")), "001/GenBI-KEPRI/XI/2026");
  // 31 Des 20:00 UTC sudah 1 Jan WIB
  assert.equal(letterNumber(12, "GenBI", new Date("2026-12-31T20:00:00Z")), "012/GenBI/I/2027");
});
