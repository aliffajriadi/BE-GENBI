import assert from "node:assert/strict";
import { it } from "node:test";
import { makeState, readState } from "../src/modules/instagram/instagram.service.js";

it("state OAuth Instagram hanya sah bila tanda tangan cocok", () => {
  const s = makeState("user-1");
  assert.equal(readState(s), "user-1");
  assert.equal(readState(s.replace("user-1", "user-2")), null); // id diganti → tanda tangan tidak cocok
  assert.equal(readState(s.slice(0, -2) + "xx"), null);
  assert.equal(readState("ngawur"), null);
});

it("rahasia Instagram terenkripsi dan bisa dibuka lagi", async () => {
  const { seal, unseal } = await import("../src/modules/instagram/instagram.service.js");
  const s = seal("rahasia-123");
  assert.ok(!s.includes("rahasia"));
  assert.equal(unseal(s), "rahasia-123");
  assert.throws(() => unseal(s.slice(0, -3) + "AAA")); // diubah → tag GCM gagal
});

it("URL login Unified Login memakai config_id, tanpa scope", async () => {
  const { loginUrl } = await import("../src/modules/instagram/instagram.service.js");
  const u = new URL(loginUrl({ appId: "111", configId: "222" }, "https://api.x.id/api/v1/instagram/callback", "st"));
  assert.equal(u.origin + u.pathname, "https://www.facebook.com/dialog/oauth");
  assert.equal(u.searchParams.get("config_id"), "222");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("override_default_response_type"), "true");
  assert.equal(u.searchParams.get("state"), "st");
  assert.equal(u.searchParams.has("scope"), false);
});
