import assert from "node:assert/strict";
import { it } from "node:test";
import { updateMeSchema } from "../src/shared/index.js";

it("username medsos dinormalisasi & divalidasi", () => {
  const p = (x: object) => updateMeSchema.safeParse(x);
  assert.equal(p({ instagram: "@genbi.kepri" }).data?.instagram, "genbi.kepri");
  assert.equal(p({ instagram: "https://www.instagram.com/genbi_kepri/" }).data?.instagram, "genbi_kepri");
  assert.equal(p({ tiktok: "https://www.tiktok.com/@genbikepri?lang=id" }).data?.tiktok, "genbikepri");
  assert.equal(p({ linkedin: "https://www.linkedin.com/in/ani-genbi-123/?originalSubdomain=id" }).data?.linkedin, "ani-genbi-123");
  assert.equal(p({ linkedin: "id.linkedin.com/in/budi" }).data?.linkedin, "budi"); // tanpa https juga diterima
  assert.equal(p({ linkedin: "https://id.linkedin.com/in/budi-santoso" }).data?.linkedin, "budi-santoso");
  assert.equal(p({ linkedin: "ani genbi" }).success, false);
  assert.equal(p({ linkedin: "" }).data?.linkedin, null);
  assert.equal(p({ instagram: "" }).data?.instagram, null);
  assert.equal(p({ instagram: "nama spasi" }).success, false);
  assert.equal(p({ website: "javascript:alert(1)" }).success, false);
  assert.equal(p({ website: "https://genbi.id" }).success, true);
});
