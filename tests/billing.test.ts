import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { billPeriod, BILL_LABEL } from "../src/modules/finance/billing.js";

describe("periode tagihan kas", () => {
  it("bulanan pakai bulan WIB, bukan UTC", () => {
    // 31 Okt 2026 20:00 UTC = 1 Nov 2026 03:00 WIB
    const p = billPeriod({ frequency: "MONTHLY", dueDay: 10, dueDate: null }, new Date("2026-10-31T20:00:00Z"));
    assert.equal(p.label, "2026-11");
    assert.equal(p.dueDate.toISOString(), "2026-11-10T16:59:59.000Z"); // 10 Nov 23:59:59 WIB
  });
  it("tanggal jatuh tempo dipotong ke akhir bulan", () => {
    const p = billPeriod({ frequency: "MONTHLY", dueDay: 31, dueDate: null }, new Date("2027-02-05T00:00:00Z"));
    assert.equal(p.dueDate.toISOString(), "2027-02-28T16:59:59.000Z");
  });
  it("semester", () => {
    assert.equal(billPeriod({ frequency: "SEMESTER", dueDay: 15, dueDate: null }, new Date("2026-03-01T00:00:00Z")).label, "2026-S1");
    assert.equal(billPeriod({ frequency: "SEMESTER", dueDay: 15, dueDate: null }, new Date("2026-08-01T00:00:00Z")).label, "2026-S2");
  });
  it("sekali bayar", () => {
    const d = new Date("2026-12-01T00:00:00Z");
    assert.deepEqual(billPeriod({ frequency: "ONCE", dueDay: null, dueDate: d }), { label: "SEKALI", dueDate: d });
  });
  it("label", () => {
    assert.equal(BILL_LABEL("2026-11"), "November 2026");
    assert.equal(BILL_LABEL("2026-S2"), "Semester 2 2026");
  });
});
