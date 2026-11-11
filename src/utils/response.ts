import type { Response } from "express";

export const ok = <T>(res: Response, data: T, meta?: unknown, status = 200) =>
  res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });
