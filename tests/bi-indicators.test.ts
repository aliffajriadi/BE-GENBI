import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { pageLines, parseIndicators } from "../src/modules/public/bi-indicators.js";

it("membaca indikator dari teks beranda bi.go.id (bukan dari menu)", () => {
  const lines = readFileSync(new URL("./fixtures/bi-lines.txt", import.meta.url), "utf8")
    .split("\n")
    .map((s) => s.replace(/[​-‍﻿]/g, "").trim())
    .filter(Boolean);
  const by = Object.fromEntries(parseIndicators(lines).map((i) => [i.key, i]));
  assert.deepEqual(by.bi_rate, { key: "bi_rate", label: "BI-Rate", value: "5,75%", period: "21 Okt 2026" });
  assert.equal(by.inflasi.value, "3,28%");
  assert.equal(by.inflasi.period, "Sep 2026");
  assert.equal(by.target_inflasi.value, "2,5±1%");
  assert.equal(by.target_inflasi.period, "2026");
  assert.equal(by.cadangan_devisa.value, "146,8");
  assert.equal(by.jisdor.value, "Rp18.103");
  assert.equal(by.jisdor.period, "09 Nov 2026");
});

it("tata letak tak dikenal → tidak ada indikator palsu", () => {
  assert.deepEqual(parseIndicators(["Menu", "BI-Rate", "Inflasi", "JISDOR"]), []);
  assert.ok(pageLines("<body><div>5,75%</div><div>BI-Rate</div></body>").includes("BI-Rate"));
});
