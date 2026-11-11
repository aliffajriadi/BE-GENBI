import { createServer } from "node:http";
import { app } from "./app.js";
import { env } from "./config/env.js";
import { startJobs } from "./jobs/index.js";
import { attachSocket } from "./modules/chat/socket.js";

// Jaring pengaman: error async yang lolos dicatat, bukan mematikan server untuk semua pengguna.
process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));

const server = createServer(app);
attachSocket(server);

server.listen(env.PORT, () => {
  console.log(`GenBI API jalan di http://localhost:${env.PORT}/api/v1`);
  if (env.NODE_ENV !== "test") startJobs();
});
