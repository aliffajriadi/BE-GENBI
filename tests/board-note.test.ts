import { test } from "node:test";
import assert from "node:assert/strict";
import { boardNoteSchema } from "../src/shared/index.js";

test("catatan divisi: link hanya http(s), kosong jadi null", () => {
  assert.equal(boardNoteSchema.parse({ title: "Canva", url: "https://www.canva.com/design/abc" }).url, "https://www.canva.com/design/abc");
  assert.equal(boardNoteSchema.parse({ title: "Catatan", url: "" }).url, null);
  assert.equal(boardNoteSchema.safeParse({ title: "x", url: "javascript:alert(1)" }).success, false);
  assert.equal(boardNoteSchema.safeParse({ title: "", url: "https://a.b" }).success, false);
});
