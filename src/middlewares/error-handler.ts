import type { ErrorRequestHandler } from "express";
import { Prisma } from "../lib/prisma.js";
import { AppError } from "../utils/app-error.js";

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    return res.status(err.status).json({ success: false, error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    return res.status(409).json({ success: false, error: { code: "CONFLICT", message: "Data sudah ada" } });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
    return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Data tidak ditemukan" } });
  }
  console.error(err);
  res.status(500).json({ success: false, error: { code: "INTERNAL", message: "Terjadi kesalahan server" } });
};
