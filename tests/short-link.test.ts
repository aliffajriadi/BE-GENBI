import { test } from "node:test";
import assert from "node:assert/strict";
import { shortLinkSchema } from "../src/shared/index.js";

const base = { url: "https://forms.gle/abc", title: "Oprec" };
test("shortlink: slug huruf kecil/angka/-, url hanya http(s)", () => {
  assert.equal(shortLinkSchema.parse({ ...base, slug: " Oprec-2026 " }).slug, "oprec-2026");
  for (const slug of ["-a", "a-", "a b", "a/b", "../x", "", "x".repeat(61)]) assert.equal(shortLinkSchema.safeParse({ ...base, slug }).success, false, slug);
  assert.equal(shortLinkSchema.safeParse({ ...base, slug: "ok", url: "javascript:alert(1)" }).success, false);
});
