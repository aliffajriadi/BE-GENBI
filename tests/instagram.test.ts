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
