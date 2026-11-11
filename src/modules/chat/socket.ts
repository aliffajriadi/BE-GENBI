import type { Server as HttpServer } from "node:http";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { buildUser, type AccessPayload, type AuthUser } from "../../middlewares/auth.js";
import { accessibleChannels, room, setIo } from "./chat.service.js";
import { boardRoom, canViewBoard } from "../planning/planning.routes.js";

// Realtime chat: klien kirim pesan lewat REST, server menyiarkan lewat Socket.IO.
// shortcut: satu instance tanpa adapter Redis (cukup untuk skala organisasi); tambah @socket.io/redis-adapter bila API di-scale >1 instance.
export function attachSocket(server: HttpServer) {
  const origin = env.WEB_ORIGIN.trim() === "*" ? true : env.WEB_ORIGIN.split(",").map((o) => o.trim());
  const io = new Server(server, { path: "/socket.io", cors: { origin } });

  io.use(async (socket, next) => {
    try {
      const p = jwt.verify(String(socket.handshake.auth?.token ?? ""), env.JWT_SECRET) as AccessPayload;
      socket.data.user = await buildUser(p);
      next();
    } catch {
      next(new Error("UNAUTHENTICATED"));
    }
  });

  io.on("connection", (socket) => {
    const u = socket.data.user as AuthUser;
    // Handler didaftarkan langsung (sinkron) supaya event yang datang saat setup belum selesai tidak hilang.
    // Error di sini TIDAK boleh lolos: promise yang gagal tanpa ditangkap mematikan seluruh proses API (Node 22).
    const ready = (async () => {
      const channels = await accessibleChannels(u);
      await socket.join(channels.map((c) => room(c.id)));
      return { me: await prisma.user.findUnique({ where: { id: u.id }, select: { id: true, name: true } }) };
    })().catch((err) => {
      console.error("socket setup gagal:", err.message);
      socket.disconnect(); // klien akan menyambung ulang otomatis
      return null;
    });

    // Papan planning: klien minta ikut room papan yang sedang dibuka (dicek hak lihatnya).
    socket.on("board:watch", async (divisionId: unknown) => {
      await ready;
      if (typeof divisionId === "string" && canViewBoard(u, divisionId)) await socket.join(boardRoom(divisionId));
    });
    socket.on("board:unwatch", (divisionId: unknown) => {
      if (typeof divisionId === "string") void socket.leave(boardRoom(divisionId));
    });

    // Indikator "sedang mengetik" hanya untuk room yang sedang diikuti socket ini (ikut berubah saat akses channel diubah).
    socket.on("typing", async (channelId: unknown) => {
      const r = await ready;
      if (r?.me && typeof channelId === "string" && socket.rooms.has(room(channelId))) socket.to(room(channelId)).emit("typing", { channelId, user: r.me });
    });
  });

  setIo(io);
  return io;
}
