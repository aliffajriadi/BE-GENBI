import assert from "node:assert/strict";
import { test } from "node:test";
import { appVersionSchema, compareVersion } from "../src/shared/index.js";

test("compareVersion membandingkan angka, bukan teks", () => {
  assert.equal(compareVersion("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersion("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersion("0.9.0", "1.0.0"), -1);
});

test("appVersionSchema menolak min > latest dan format salah", () => {
  const base = { minVersion: "1.0.0", latestVersion: "1.2.0", url: "https://contoh.id/app.apk" };
  assert.ok(appVersionSchema.safeParse(base).success);
  assert.ok(!appVersionSchema.safeParse({ ...base, minVersion: "1.3.0" }).success);
  assert.ok(!appVersionSchema.safeParse({ ...base, latestVersion: "1.2" }).success);
  assert.ok(!appVersionSchema.safeParse({ ...base, url: "javascript:alert(1)" }).success);
});
