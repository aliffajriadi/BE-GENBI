// E2E alur absensi. Jalankan API ke DB kosong yang sudah di-seed, lalu: E2E_URL=http://localhost:4000/api/v1 node tests/e2e-flow.mjs
import assert from "node:assert/strict";
const B = process.env.E2E_URL ?? "http://localhost:4000/api/v1";
async function call(token, method, path, body) {
  const r = await fetch(B + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}
const ok = async (p) => { const r = await p; if (!r.success) throw new Error(JSON.stringify(r)); return r.data; };
const login = async (email, password) => (await ok(call(null, "POST", "/auth/login", { email, password }))).accessToken;
const step = (s) => console.log("✓", s);

const sfx = Date.now().toString(36);
const admin = await login("admin@genbi.local", "admin12345");
const media = await ok(call(admin, "POST", "/divisions", { name: "Media " + sfx, slug: "media-" + sfx }));
const riset = await ok(call(admin, "POST", "/divisions", { name: "Riset " + sfx, slug: "riset-" + sfx }));
const mk = (n, roleKey, divisionId) => ok(call(admin, "POST", "/users", { email: `${n.toLowerCase().replace(/ /g, "")}-${sfx}@t.id`, name: n, password: "password123", roleKey, divisionId }));
const sek = await mk("Sekretaris", "SEKRETARIS");
const kadiv = await mk("Kadiv Media", "KADIV", media.id);
const a1 = await mk("Ani", "ANGGOTA", media.id);
const a2 = await mk("Budi", "ANGGOTA", media.id);
const a3 = await mk("Citra", "ANGGOTA", riset.id);
step("buat divisi & user");

const S = await login(`sekretaris-${sfx}@t.id`, "password123");
const K = await login(`kadivmedia-${sfx}@t.id`, "password123");
const A1 = await login(`ani-${sfx}@t.id`, "password123");
const A2 = await login(`budi-${sfx}@t.id`, "password123");
const A3 = await login(`citra-${sfx}@t.id`, "password123");

const forbidden = await call(A1, "POST", "/events", { title: "x", type: "KEGIATAN", startAt: new Date(), endAt: new Date(), lateAfter: new Date() });
assert.equal(forbidden.status, 403); step("anggota tidak bisa buat event (403)");

const now = Date.now();
const ev = await ok(call(S, "POST", "/events", { title: "Rapat Pleno " + sfx, type: "RAPAT_PLENO", startAt: new Date(now - 60_000), lateAfter: new Date(now + 600_000), endAt: new Date(now + 3_600_000), scope: "ALL", pointHadir: 12 }));
step("sekretaris buat event");

const kev = await ok(call(K, "POST", "/events", { title: "Rapat Media", type: "RAPAT_DIVISI", startAt: new Date(now - 60_000), lateAfter: new Date(now - 30_000), endAt: new Date(now + 3_600_000) }));
assert.equal(kev.scope, "DIVISION"); assert.equal(kev.divisionId, media.id); step("kadiv event dipaksa ke divisinya");

const kBase = { type: "RAPAT_DIVISI", startAt: new Date(now + 864e5), lateAfter: new Date(now + 864e5 + 6e5), endAt: new Date(now + 864e5 + 36e5) };
assert.equal((await call(K, "POST", "/events", { ...kBase, title: "Rapat kecil", scope: "MANUAL", participantIds: [a1.id, a3.id] })).status, 400); // Citra beda divisi
const kman = await ok(call(K, "POST", "/events", { ...kBase, title: "Rapat desain", scope: "MANUAL", participantIds: [a1.id] }));
assert.equal(kman.scope, "MANUAL"); assert.equal(kman.divisionId, media.id);
const evList = async (t) => (await ok(call(t, "GET", "/events"))).map((e) => e.id);
assert.ok((await evList(A1)).includes(kman.id) && (await evList(K)).includes(kman.id));
assert.ok(!(await evList(A2)).includes(kman.id)); // Budi satu divisi tapi tidak dipilih
assert.equal((await call(K, "PUT", `/events/${kman.id}/participants`, { participantIds: [a1.id, a3.id] })).status, 400);
await ok(call(K, "PUT", `/events/${kman.id}/participants`, { participantIds: [a1.id, a2.id] }));
assert.deepEqual((await ok(call(K, "GET", `/events/${kman.id}/participants`))).map((p) => p.name).sort(), ["Ani", "Budi"]);
assert.ok((await evList(A2)).includes(kman.id));
assert.equal((await call(A1, "PUT", `/events/${kman.id}/participants`, { participantIds: [a1.id] })).status, 403);
await ok(call(K, "DELETE", `/events/${kman.id}`)); // bersihkan supaya tidak memengaruhi rekap/poin di bawah
step("kadiv buat rapat peserta pilihan, hanya anggota divisinya");

await ok(call(A2, "POST", `/events/${ev.id}/leave-requests`, { kind: "SAKIT", reason: "Demam tinggi" }));
const leaves = await ok(call(S, "GET", `/events/${ev.id}/leave-requests`));
await ok(call(S, "PATCH", `/leave-requests/${leaves[0].id}`, { status: "APPROVED" }));
step("izin diajukan & disetujui");

assert.equal((await call(A1, "POST", "/attendance/scan", { token: `${ev.id}.${now}.xxx`, deviceId: "d1" })).error.code, "NOT_OPEN");
await ok(call(S, "POST", `/events/${ev.id}/open`));
const qr = await ok(call(S, "GET", `/events/${ev.id}/qr-token`));
assert.ok(qr.counts.total >= 5);
step(`absensi dibuka, peserta ${qr.counts.total}`);

const scan1 = await ok(call(A1, "POST", "/attendance/scan", { token: qr.token, deviceId: "hp-ani" }));
assert.equal(scan1.status, "HADIR");
assert.equal((await call(A1, "POST", "/attendance/scan", { token: qr.token, deviceId: "hp-ani" })).error.code, "ALREADY_RECORDED");
step("scan hadir + tolak scan dobel");

const forged = qr.token.slice(0, -2) + (qr.token.endsWith("AA") ? "BB" : "AA");
assert.equal((await call(A3, "POST", "/attendance/scan", { token: forged, deviceId: "hp-citra" })).error.code, "INVALID_QR");
const [eid] = qr.token.split(".");
assert.equal((await call(A3, "POST", "/attendance/scan", { token: `${eid}.${Date.now() - 60_000}.abc`, deviceId: "hp-citra" })).error.code, "INVALID_QR");
step("QR palsu ditolak");

// Device binding: Ani sudah terikat ke hp-ani.
await ok(call(K, "POST", `/events/${kev.id}/open`));
const kqr = await ok(call(K, "GET", `/events/${kev.id}/qr-token`));
assert.equal((await call(A1, "POST", "/attendance/scan", { token: kqr.token, deviceId: "hp-lain" })).error.code, "DEVICE_MISMATCH");
step("device lain ditolak");
assert.equal((await call(A3, "POST", "/attendance/scan", { token: kqr.token, deviceId: "hp-citra" })).error.code, "NOT_PARTICIPANT");
step("anggota divisi lain bukan peserta rapat divisi");
const telat = await ok(call(A1, "POST", "/attendance/scan", { token: kqr.token, deviceId: "hp-ani" }));
assert.equal(telat.status, "TELAT"); step("lewat batas → TELAT");

// Scan balik oleh panitia
const me3 = await ok(call(A3, "GET", "/me"));
const sb = await ok(call(S, "POST", "/attendance/scan-member", { eventId: ev.id, memberToken: me3.memberQr }));
assert.equal(sb.status, "HADIR"); step("scan balik QR personal");

assert.equal((await call(K, "POST", `/events/${ev.id}/close`)).status, 403); step("kadiv tidak bisa tutup event pleno");
const closed = await ok(call(S, "POST", `/events/${ev.id}/close`));
const by = Object.fromEntries(closed.list.map((r) => [r.name, r.status]));
assert.equal(by.Budi, "SAKIT"); assert.equal(by.Kadiv_Media ?? by["Kadiv Media"], "ALPA"); assert.equal(by.Ani, "HADIR");
step(`tutup: ${JSON.stringify(closed.counts)}`);

let p1 = await ok(call(A1, "GET", "/points/me"));
assert.equal(p1.total, 12 + 5); step("poin Ani = 12 (override) + 5 (telat)");
let pk = await ok(call(K, "GET", "/points/me"));
assert.equal(pk.total, -5); step("poin Kadiv alpa = -5");

await ok(call(S, "POST", "/attendance/manual", { eventId: ev.id, userId: kadiv.id, status: "HADIR", reason: "Lupa scan, hadir dicek notulen" }));
pk = await ok(call(K, "GET", "/points/me"));
assert.equal(pk.total, 12); step("koreksi manual ALPA→HADIR: ledger -5 dibalik, +12");

assert.equal((await call(K, "POST", "/points/adjust", { userId: a3.id, points: 10, note: "bantu desain" })).status, 403);
await ok(call(K, "POST", "/points/adjust", { userId: a2.id, points: 30, ruleKey: "PANITIA", note: "Panitia seminar" }));
step("kadiv beri poin hanya ke divisinya");

const rules = await ok(call(S, "GET", "/point-rules"));
const hadir = rules.find((r) => r.key === "HADIR");
await ok(call(S, "PATCH", `/point-rules/${hadir.id}`, { points: 15 }));
assert.equal((await call(K, "PATCH", `/point-rules/${hadir.id}`, { points: 1 })).status, 403);
step("aturan poin hanya bisa diubah sekretaris");

const board = await ok(call(A1, "GET", "/points/leaderboard"));
assert.equal(board[0].name, "Budi"); step(`leaderboard: ${board.map((b) => `${b.name}=${b.points}`).join(", ")}`);

await ok(call(K, "POST", `/events/${kev.id}/close`));
const recap = await ok(call(S, "GET", "/attendance/recap"));
assert.equal(recap.find((r) => r.name === "Ani").percent, 100); step("rekap persentase");
const krecap = await ok(call(K, "GET", "/attendance/recap"));
assert.ok(krecap.every((r) => r.division?.startsWith("Media"))); step("kadiv rekap hanya divisinya");

const xr = await fetch(`${B}/events/${ev.id}/attendance/export`, { headers: { Authorization: `Bearer ${S}` } });
assert.equal(xr.status, 200); assert.ok((await xr.arrayBuffer()).byteLength > 1000); step("export excel");

const audit = await ok(call(admin, "GET", "/audit-logs"));
assert.ok(audit.some((a) => a.action === "attendance.manual")); step("audit log tercatat");
const dash = await ok(call(A1, "GET", "/dashboard")); assert.ok(dash.points.rank >= 1); step("dashboard");

// refresh rotation & reuse detection
const lr = await ok(call(null, "POST", "/auth/login", { email: `ani-${sfx}@t.id`, password: "password123" }));
const r1 = await ok(call(null, "POST", "/auth/refresh", { refreshToken: lr.refreshToken }));
assert.equal((await call(null, "POST", "/auth/refresh", { refreshToken: lr.refreshToken })).status, 401);
assert.equal((await call(null, "POST", "/auth/refresh", { refreshToken: r1.refreshToken })).status, 401);
step("refresh token rotasi + reuse mencabut sesi");
// profil & password
const upd = await ok(call(A1, "PATCH", "/me", { phone: "0812", campus: "UNRIKA", nim: null }));
assert.equal(upd.phone, "0812");
assert.equal((await call(A1, "PATCH", "/me", { email: "x@y.z" })).success, true); // field di luar schema diabaikan
assert.equal((await call(A1, "POST", "/auth/change-password", { currentPassword: "salah", newPassword: "passwordbaru1" })).status, 400);
const np = await ok(call(A1, "POST", "/auth/change-password", { currentPassword: "password123", newPassword: "passwordbaru1" }));
assert.ok(np.accessToken);
await login(`ani-${sfx}@t.id`, "passwordbaru1");
step("ubah profil & ganti password");

// data publik tanpa login
const pub = await ok(call(null, "GET", "/public/stats"));
assert.ok(pub.members >= 5); step("statistik publik");

// detail anggota & filter role
const det = await ok(call(S, "GET", `/users/${a1.id}`));
assert.ok(det.points.total > 0 && det.attendance.length >= 1);
const kadivs = await ok(call(S, "GET", "/users?role=KADIV"));
assert.ok(kadivs.every((u) => u.role === "KADIV")); step("detail anggota & filter role");
// ───── Upload, kas, notifikasi ─────
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
async function upload(token, bytes, name, extra = {}) {
  const fd = new FormData();
  fd.append("file", new Blob([bytes]), name);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  const r = await fetch(B + "/uploads", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
  return { status: r.status, ...(await r.json()) };
}
const ANI = np.accessToken;
assert.equal((await upload(ANI, Buffer.from("halo bukan gambar"), "a.png")).status, 400);
step("upload menolak file palsu");

await mk("Bendahara", "BENDAHARA");
const BEN = await login(`bendahara-${sfx}@t.id`, "password123");
assert.equal((await call(A1, "POST", "/dues-plans", { name: "Kas", amount: 1, frequency: "MONTHLY" })).status, 403);
await ok(call(BEN, "POST", "/bank-accounts", { bankName: "BSI", accountNumber: "7123456789", accountName: "GenBI" }));
const plan = await ok(call(BEN, "POST", "/dues-plans", { name: "Kas bulanan", amount: 20000, frequency: "MONTHLY", dueDay: 28 }));
assert.ok(plan.generated >= 5); step(`rencana iuran → ${plan.generated} tagihan`);

const [aniBill] = await ok(call(ANI, "GET", "/bills/me"));
assert.equal(aniBill.status, "UNPAID");
const proof = await ok(upload(ANI, PNG, "bukti.png"));
assert.equal((await call(ANI, "POST", "/payments", { billIds: [aniBill.id], amount: 1000, transferDate: new Date(), proofId: proof.id })).status, 400);
const pay = await ok(call(ANI, "POST", "/payments", { billIds: [aniBill.id], amount: 20000, transferDate: new Date(), proofId: proof.id }));
assert.equal((await call(ANI, "POST", "/payments", { billIds: [aniBill.id], amount: 20000, transferDate: new Date(), proofId: proof.id })).status, 400);
step("bayar + tolak nominal kurang & bayar dobel");

assert.equal((await fetch(B + proof.url, { headers: { Authorization: `Bearer ${A3}` } })).status, 403);
assert.equal((await fetch(B + proof.url, { headers: { Authorization: `Bearer ${BEN}` } })).status, 200);
step("bukti bayar hanya bisa dibuka pemilik & bendahara");

const benNotif = await ok(call(BEN, "GET", "/notifications"));
assert.ok(benNotif.items.some((n) => n.type === "PAYMENT_NEW"));
await ok(call(BEN, "POST", `/payments/${pay.id}/verify`));
assert.equal((await call(BEN, "POST", `/payments/${pay.id}/verify`)).status, 409);
assert.equal((await ok(call(ANI, "GET", "/bills/me")))[0].status, "PAID");
const sum = await ok(call(BEN, "GET", "/finance/summary"));
assert.equal(sum.balance, 20000);
const aniPts = await ok(call(ANI, "GET", "/points/me"));
assert.ok(aniPts.history.some((h) => h.sourceType === "KAS" && h.points === 5));
const aniNotif = await ok(call(ANI, "GET", "/notifications"));
assert.ok(aniNotif.items.some((n) => n.type === "PAYMENT_VERIFIED") && aniNotif.unread > 0);
await ok(call(ANI, "POST", "/notifications/read", {}));
assert.equal((await ok(call(ANI, "GET", "/notifications"))).unread, 0);
step("verifikasi: lunas, buku kas, poin tepat waktu, notifikasi");

const [budiBill] = await ok(call(A2, "GET", "/bills/me"));
const bp = await ok(upload(A2, PNG, "b.png"));
const bpay = await ok(call(A2, "POST", "/payments", { billIds: [budiBill.id], amount: 20000, transferDate: new Date(), proofId: bp.id }));
await ok(call(BEN, "POST", `/payments/${bpay.id}/reject`, { reason: "Nominal di bukti tidak terbaca" }));
assert.equal((await ok(call(A2, "GET", "/bills/me")))[0].status, "REJECTED");
await ok(call(A2, "POST", "/payments", { billIds: [budiBill.id], amount: 20000, transferDate: new Date(), proofId: bp.id }));
step("tolak bukti → upload ulang");

await ok(call(BEN, "POST", "/cash-transactions", { type: "OUT", category: "Konsumsi", amount: 5000, date: new Date(), description: "Snack rapat" }));
assert.equal((await ok(call(BEN, "GET", "/finance/summary"))).balance, 15000);
assert.equal((await fetch(B + "/finance/report/export", { headers: { Authorization: `Bearer ${BEN}` } })).status, 200);
step("buku kas & laporan");

const av = await ok(upload(ANI, PNG, "me.png", { public: "true" }));
assert.ok(av.url.startsWith("/storage/public/"));
assert.equal((await ok(call(ANI, "PATCH", "/me", { avatarUrl: av.url }))).avatarUrl, av.url);
assert.equal((await call(A2, "PATCH", "/me", { avatarUrl: av.url })).status, 400); // foto milik orang lain
assert.equal((await call(A2, "PATCH", "/me", { avatarUrl: "https://contoh.com/x.jpg" })).status, 400);
assert.equal((await call(ANI, "POST", "/uploads", {})).status, 400);
assert.equal((await ok(call(ANI, "PATCH", "/me", { avatarUrl: null }))).avatarUrl, null);
step("foto profil: pasang, tolak milik orang lain, hapus");

const dir = await ok(call(A3, "GET", "/members?q=Ani"));
assert.ok(dir.some((m) => m.id === a1.id) && dir.every((m) => !("email" in m) && !("phone" in m) && !("nim" in m)));
const prof = await ok(call(A3, "GET", `/members/${a1.id}`));
assert.ok(prof.stats.points > 0 && !("email" in prof) && !("phone" in prof) && !("deviceId" in prof));
assert.equal((await call(A3, "GET", `/users/${a1.id}`)).status, 403); // data pribadi tetap untuk pengurus
step("anggota bisa lihat profil anggota lain tanpa data pribadi");

const cover = await ok(upload(ANI, PNG, "cover.png", { public: "true" }));
const soc = await ok(call(ANI, "PATCH", "/me", { coverUrl: cover.url, bio: "Suka menulis.", instagram: "@ani.genbi", tiktok: "https://www.tiktok.com/@anigenbi?lang=id", website: "https://ani.id" }));
assert.equal(soc.instagram, "ani.genbi"); assert.equal(soc.tiktok, "anigenbi");
assert.equal((await call(A2, "PATCH", "/me", { coverUrl: cover.url })).status, 400);
assert.equal((await call(ANI, "PATCH", "/me", { website: "javascript:alert(1)" })).status, 400);
const seen = await ok(call(A3, "GET", `/members/${a1.id}`));
assert.equal(seen.bio, "Suka menulis."); assert.equal(seen.coverUrl, cover.url); assert.equal(seen.website, "https://ani.id");
step("latar profil, bio & medsos tampil di profil");

const pubList = await ok(call(null, "GET", "/public/members"));
assert.ok(pubList.some((m) => m.id === a1.id) && !pubList.some((m) => m.name === "System Administrator"));
const pubAni = await ok(call(null, "GET", `/public/members/${a1.id}`));
assert.equal(pubAni.bio, "Suka menulis.");
for (const k of ["email", "phone", "nim", "campus", "major", "deviceId", "passwordHash"]) assert.ok(!(k in pubAni), `bocor: ${k}`);
await ok(call(ANI, "PATCH", "/me", { profilePublic: false }));
assert.equal((await call(null, "GET", `/public/members/${a1.id}`)).status, 404);
assert.ok(!(await ok(call(null, "GET", "/public/members"))).some((m) => m.id === a1.id));
await ok(call(ANI, "PATCH", "/me", { profilePublic: true }));
step("halaman Anggota publik tanpa data pribadi, bisa disembunyikan");

// ───── Chat realtime ─────
const { io } = await import("socket.io-client");
const sockOf = (token) => new Promise((res, rej) => { const s = io(new URL(B).origin, { auth: { token }, transports: ["websocket"] }); s.on("connect", () => res(s)); s.on("connect_error", rej); });
const chAni = (await ok(call(ANI, "GET", "/channels"))).channels;
const umum = chAni.find((c) => c.name === "umum");
const chMedia = chAni.find((c) => c.type === "DIVISION");
assert.ok(umum && chMedia && !chAni.some((c) => c.type === "CORE"));
assert.equal((await call(A3, "GET", `/channels/${chMedia.id}/messages`)).status, 404); // Citra beda divisi
await assert.rejects(sockOf("token-palsu"));
const sAni = await sockOf(ANI), sCitra = await sockOf(A3);
const got = { ani: [], citra: [], typing: [] };
sAni.on("message:new", (m) => got.ani.push(m)); sCitra.on("message:new", (m) => got.citra.push(m));
sAni.on("typing", (t) => got.typing.push(t));
sCitra.emit("typing", umum.id); sCitra.emit("typing", chMedia.id); // yang kedua harus diabaikan
const m1 = await ok(call(A2, "POST", `/channels/${umum.id}/messages`, { body: "Halo semua 👋" }));
await ok(call(A2, "POST", `/channels/${chMedia.id}/messages`, { body: "Rahasia divisi media" }));
await new Promise((r) => setTimeout(r, 400));
assert.ok(got.ani.some((m) => m.id === m1.id) && got.citra.some((m) => m.id === m1.id));
assert.ok(got.ani.some((m) => m.body === "Rahasia divisi media") && !got.citra.some((m) => m.body === "Rahasia divisi media"));
assert.equal(got.typing.length, 1);
step("pesan realtime terkirim, channel divisi hanya ke anggotanya, typing indicator");

assert.equal((await ok(call(ANI, "GET", "/channels"))).channels.find((c) => c.id === umum.id).unread, 1);
await ok(call(ANI, "POST", `/channels/${umum.id}/read`));
assert.equal((await ok(call(ANI, "GET", "/channels"))).channels.find((c) => c.id === umum.id).unread, 0);
const reply = await ok(call(ANI, "POST", `/channels/${umum.id}/messages`, { body: "Halo juga", replyToId: m1.id }));
assert.equal(reply.replyTo.id, m1.id);
assert.equal((await call(ANI, "PATCH", `/messages/${m1.id}`, { body: "ubah punya orang" })).status, 403);
assert.ok((await ok(call(A2, "PATCH", `/messages/${m1.id}`, { body: "Halo semua!" }))).editedAt);
assert.equal((await call(ANI, "DELETE", `/messages/${m1.id}`)).status, 403);
assert.equal((await call(ANI, "POST", `/messages/${reply.id}/pin`)).status, 403);
await ok(call(S, "POST", `/messages/${reply.id}/pin`)); // sekretaris moderator
await ok(call(S, "DELETE", `/messages/${m1.id}`));
const page = await ok(call(ANI, "GET", `/channels/${umum.id}/messages`));
const del = page.find((m) => m.id === m1.id);
assert.ok(del.deleted && del.body === null && page.find((m) => m.id === reply.id).replyTo.body === null);
assert.equal((await ok(call(ANI, "GET", `/channels/${umum.id}/pinned`))).length, 1);
sAni.close(); sCitra.close();
step("belum dibaca, balas, edit, hapus oleh moderator, sematkan");

// ───── Kelola diskusi ─────
const list = async (t) => (await ok(call(t, "GET", "/channels"))).channels;
assert.equal((await call(ANI, "POST", "/channels", { name: "iseng", scope: "ALL" })).status, 403); // anggota biasa
assert.equal((await call(K, "POST", "/channels", { name: "semua", scope: "ALL" })).status, 403); // kadiv tak boleh lingkup umum
assert.equal((await call(K, "POST", "/channels", { name: "campur", scope: "MEMBERS", memberIds: [a1.id, a3.id] })).status, 400); // Citra beda divisi
const proj = await ok(call(K, "POST", "/channels", { name: "proyek poster", description: "Desain poster seminar", scope: "MEMBERS", memberIds: [a1.id] }));
assert.equal(proj.divisionId, media.id); // otomatis terkunci ke divisi kadiv
assert.ok((await list(ANI)).some((c) => c.id === proj.id && !c.canManage && c.canPost));
assert.ok(!(await list(A2)).some((c) => c.id === proj.id)); // Budi bukan anggota
assert.ok(!(await list(A3)).some((c) => c.id === proj.id));
assert.equal((await call(A2, "GET", `/channels/${proj.id}/messages`)).status, 404);
assert.equal((await call(ANI, "PATCH", `/channels/${proj.id}`, { name: "ubah" })).status, 403);
step("kadiv buat diskusi khusus anggota divisinya");

const sBudi = await sockOf(A2);
const budiGot = [];
let changed = 0;
sBudi.on("channels:changed", () => changed++);
sBudi.on("message:new", (m) => budiGot.push(m));
await ok(call(K, "PATCH", `/channels/${proj.id}`, { memberIds: [a1.id, a2.id], readOnly: true }));
await new Promise((r) => setTimeout(r, 300));
assert.ok(changed > 0 && (await list(A2)).some((c) => c.id === proj.id));
assert.equal((await call(ANI, "POST", `/channels/${proj.id}/messages`, { body: "boleh?" })).status, 403); // mode pengumuman
await ok(call(K, "POST", `/channels/${proj.id}/messages`, { body: "Deadline poster Jumat" }));
await new Promise((r) => setTimeout(r, 300));
assert.ok(budiGot.some((m) => m.body === "Deadline poster Jumat")); // langsung masuk room tanpa reconnect
const who = await ok(call(ANI, "GET", `/channels/${proj.id}/members`));
assert.deepEqual(who.map((x) => x.name).sort(), ["Ani", "Budi", "Kadiv Media"]);
step("atur anggota & mode pengumuman, berlaku realtime");

const divCh = await ok(call(K, "POST", "/channels", { name: "rapat media", scope: "DIVISION", divisionId: riset.id }));
assert.equal(divCh.divisionId, media.id); // divisionId lain diabaikan untuk kadiv
assert.ok(!(await list(A3)).some((c) => c.id === divCh.id));
const allCh = await ok(call(S, "POST", "/channels", { name: "pengumuman", scope: "ALL", readOnly: true }));
assert.ok((await list(A3)).some((c) => c.id === allCh.id && !c.canPost));
await ok(call(K, "DELETE", `/channels/${proj.id}`));
assert.ok(!(await list(ANI)).some((c) => c.id === proj.id));
assert.equal((await call(K, "DELETE", `/channels/${umum.id}`)).status, 403); // kadiv bukan pengelola #umum
sBudi.close();
step("diskusi per divisi, umum oleh sekretaris, arsip");

// ───── Artikel (tanpa approval, kabar vs tulisan anggota) ─────
assert.equal((await call(ANI, "POST", "/articles", { title: "Kabar resmi", kind: "NEWS" })).status, 403);
const art = await ok(call(ANI, "POST", "/articles", { title: "Literasi Keuangan di Kampus" }));
assert.equal(art.kind, "PERSONAL");
assert.equal((await call(ANI, "POST", `/articles/${art.id}/publish`, {})).status, 400); // isi masih kosong
await ok(call(ANI, "PATCH", `/articles/${art.id}`, { body: "## Pembuka\n\nSumber: OJK 2025. " + "Isi artikel tentang literasi keuangan. ".repeat(8), tags: ["Edukasi", "Keuangan"] }));
assert.equal((await call(A3, "GET", `/articles/${art.id}`)).status, 403);
await ok(call(ANI, "POST", `/articles/${art.id}/publish`, {}));
const personal = await ok(call(null, "GET", "/public/articles?kind=PERSONAL"));
assert.ok(personal.some((a) => a.slug === art.slug && a.readMinutes >= 1));
assert.ok(!(await ok(call(null, "GET", "/public/articles?kind=NEWS"))).some((a) => a.slug === art.slug));
const pubOne = await ok(call(null, "GET", `/public/articles/${art.slug}?view=1`));
assert.ok(pubOne.body.includes("OJK") && pubOne.tags.length === 2);
const artPts = async () => (await ok(call(ANI, "GET", "/points/me"))).history.filter((h) => h.sourceType === "ARTICLE").reduce((s, h) => s + h.points, 0);
assert.equal(await artPts(), 15);
step("anggota menerbitkan tulisan langsung, tampil di Tulisan Anggota + poin");

await ok(call(S, "POST", `/articles/${art.id}/archive`)); // moderator menurunkan
assert.equal(await artPts(), 0);
await ok(call(ANI, "POST", `/articles/${art.id}/publish`, {}));
assert.equal(await artPts(), 15);
step("diturunkan → poin dibalik; terbit lagi → poin kembali sekali");

const news = await ok(call(K, "POST", "/articles", { title: "Seminar Literasi Keuangan 3 Kampus", kind: "NEWS" }));
await ok(call(K, "PATCH", `/articles/${news.id}`, { body: "Liputan kegiatan. ".repeat(20) }));
await ok(call(K, "POST", `/articles/${news.id}/publish`, {}));
assert.ok((await ok(call(null, "GET", "/public/articles?kind=NEWS"))).some((a) => a.id === news.id));
step("kadiv menulis kabar organisasi");

// ───── Administrasi ─────
const letter = await ok(call(S, "POST", "/letters", { direction: "OUT", subject: "Undangan seminar", counterparty: "BEM", date: new Date() }));
assert.match(letter.number, /^001\//);
const letter2 = await ok(call(S, "POST", "/letters", { direction: "OUT", subject: "Peminjaman ruang", counterparty: "Kampus", date: new Date() }));
assert.match(letter2.number, /^002\//);
assert.equal((await call(ANI, "GET", "/letters")).status, 403);
step(`surat keluar bernomor otomatis (${letter.number})`);

const minute = await ok(call(S, "POST", "/minutes", { eventId: ev.id, content: "Pembahasan program kerja", decisions: "Seminar 20 Des", actionItems: [{ title: "Buat poster", picId: a1.id }] }));
assert.equal((await call(S, "POST", "/minutes", { eventId: ev.id, content: "dobel notulen" })).status, 409);
const tasks = await ok(call(ANI, "GET", "/action-items"));
assert.equal(tasks.length, 1);
await ok(call(ANI, "PATCH", `/action-items/${tasks[0].id}`, { done: true }));
const mdet = await ok(call(ANI, "GET", `/minutes/${minute.id}`));
assert.ok(mdet.present.includes("Ani"));
step("notulen + tugas PIC");

const docFile = await ok(upload(S, Buffer.from("%PDF-1.4 test"), "adart.pdf"));
await ok(call(S, "POST", "/documents", { title: "AD/ART", category: "Organisasi", fileId: docFile.id, visibility: "SEMUA" }));
assert.equal((await ok(call(ANI, "GET", "/documents"))).items.length, 1);
assert.equal((await fetch(B + docFile.url, { headers: { Authorization: `Bearer ${ANI}` } })).status, 200);
step("arsip dokumen publik untuk anggota");

// ───── Kelola divisi: Kadiv mendelegasikan akses ke anggota divisinya ─────
const evBody = (title, extra = {}) => ({ title, type: "RAPAT_DIVISI", startAt: new Date(Date.now() + 2 * 864e5), lateAfter: new Date(Date.now() + 2 * 864e5 + 6e5), endAt: new Date(Date.now() + 2 * 864e5 + 36e5), ...extra });
assert.equal((await call(A2, "POST", "/events", evBody("Rapat Budi"))).status, 403);
assert.equal((await call(ANI, "GET", `/divisions/${media.id}/access`)).status, 403);
assert.equal((await call(K, "GET", `/divisions/${riset.id}/access`)).status, 403);
const acc = await ok(call(K, "GET", `/divisions/${media.id}/access`));
assert.ok(acc.members.some((m) => m.name === "Budi") && acc.members.find((m) => m.name === "Kadiv Media").isHead);
assert.equal((await call(K, "PUT", `/divisions/${media.id}/access/${a3.id}`, { areas: ["events"] })).status, 400); // Citra divisi lain
assert.equal((await call(K, "PUT", `/divisions/${media.id}/access/${a2.id}`, { areas: ["admin"] })).status, 400); // area tak dikenal
await ok(call(K, "PUT", `/divisions/${media.id}/access/${a2.id}`, { areas: ["events", "points"] }));
const meBudi = await ok(call(A2, "GET", "/me"));
assert.ok(meBudi.permissions.includes("event.create") && meBudi.divisionGrants.includes("events"));
const bev = await ok(call(A2, "POST", "/events", evBody("Rapat koordinasi konten", { scope: "ALL" })));
assert.equal(bev.scope, "DIVISION"); assert.equal(bev.divisionId, media.id); // tetap terkunci ke divisinya
assert.equal((await call(A2, "POST", "/events", evBody("Rapat campur", { scope: "MANUAL", participantIds: [a3.id] }))).status, 400);
assert.equal((await call(A2, "POST", `/events/${ev.id}/open`)).status, 403); // rapat pleno bukan kegiatan divisinya
await ok(call(A2, "POST", "/points/adjust", { userId: a1.id, points: 5, note: "Bantu dokumentasi" }));
assert.equal((await call(A2, "POST", "/points/adjust", { userId: a3.id, points: 5, note: "beda divisi" })).status, 403);
step("anggota diberi akses kegiatan & poin, tetap terkunci di divisinya");

await ok(call(K, "PUT", `/divisions/${media.id}/access/${a1.id}`, { areas: ["chat"] }));
assert.equal((await call(ANI, "POST", "/channels", { name: "umum2", scope: "ALL" })).status, 403);
const aniCh = await ok(call(ANI, "POST", "/channels", { name: "tim konten", scope: "MEMBERS", memberIds: [a2.id] }));
assert.equal(aniCh.divisionId, media.id);
await ok(call(K, "PUT", `/divisions/${media.id}/access/${a2.id}`, { areas: [] })); // cabut
assert.equal((await call(A2, "POST", "/events", evBody("Rapat lagi"))).status, 403); // langsung berlaku
await ok(call(S, "PUT", `/divisions/${riset.id}/access/${a3.id}`, { areas: ["events"] })); // sekretaris bisa semua divisi
step("akses diskusi divisi, cabut akses langsung berlaku");

console.log("SEMUA LULUS");
