// Regresi: banyak socket tersambung bersamaan ke DB yang belum punya channel dulu bikin deadlock & API crash.
// Jalankan API ke DB yang sudah di-seed, lalu: E2E_URL=http://localhost:4000/api/v1 node tests/chat-burst.mjs
import assert from "node:assert/strict";
import { io } from "socket.io-client";
const B = process.env.E2E_URL ?? "http://localhost:4000/api/v1";
const { data } = await (await fetch(`${B}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@genbi.local", password: "admin12345" }) })).json();
const N = 40;
const sockets = await Promise.all(
  Array.from({ length: N }, () => new Promise((res, rej) => {
    const s = io(new URL(B).origin, { auth: { token: data.accessToken }, transports: ["websocket"] });
    s.on("connect", () => res(s));
    s.on("connect_error", rej);
  })),
);
await new Promise((r) => setTimeout(r, 1500));
const health = await fetch(`${new URL(B).origin}/health`).then((r) => r.ok).catch(() => false);
const channels = (await (await fetch(`${B}/channels`, { headers: { Authorization: `Bearer ${data.accessToken}` } })).json()).data.channels;
sockets.forEach((s) => s.close());
assert.ok(health, "API mati setelah banyak koneksi bersamaan");
assert.equal(new Set(channels.map((c) => c.name)).size, channels.length, "channel dobel");
console.log(`✓ ${N} socket bersamaan, API tetap hidup, ${channels.length} channel tanpa duplikat`);
