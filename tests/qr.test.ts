import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { distanceM, eventToken, memberToken, verifyEventToken, verifyMemberToken } from "../src/modules/events/qr.js";

describe("QR absensi", () => {
  const now = 1_800_000_013_000;

  it("token valid dalam 30 detik, kedaluwarsa setelahnya", () => {
    const { token } = eventToken("evt1", "sess", now);
    assert.equal(verifyEventToken(token, "sess", now), "OK");
    assert.equal(verifyEventToken(token, "sess", now + 15_000), "OK");
    assert.equal(verifyEventToken(token, "sess", now + 31_000), "EXPIRED");
  });

  it("token dari sesi lain / diubah ditolak", () => {
    const { token } = eventToken("evt1", "sess", now);
    assert.equal(verifyEventToken(token, "sess-baru", now), "INVALID");
    assert.equal(verifyEventToken(token.replace("evt1", "evt2"), "sess", now), "INVALID");
    assert.equal(verifyEventToken("sampah", "sess", now), "INVALID");
  });

  it("token berganti tiap 20 detik", () => {
    assert.equal(eventToken("e", "s", 0).token, eventToken("e", "s", 19_999).token);
    assert.notEqual(eventToken("e", "s", 0).token, eventToken("e", "s", 20_000).token);
  });

  it("QR personal anggota", () => {
    const t = memberToken("user123");
    assert.equal(verifyMemberToken(t), "user123");
    assert.equal(verifyMemberToken(t.replace("user123", "user999")), null);
  });

  it("jarak geofence", () => {
    assert.equal(distanceM(1.0, 104.0, 1.0, 104.0), 0);
    assert.equal(Math.round(distanceM(0, 0, 0, 0.001)), 111);
  });
});
