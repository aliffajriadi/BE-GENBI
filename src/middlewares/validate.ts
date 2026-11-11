import type { RequestHandler } from "express";
import type { ZodType } from "zod";
import { AppError } from "../utils/app-error.js";

// Validasi body; hasil parse menggantikan req.body.
export const validate =
  (schema: ZodType): RequestHandler =>
  (req, _res, next) => {
    const r = schema.safeParse(req.body ?? {});
    if (!r.success) throw new AppError("VALIDATION", 400, "Input tidak valid", r.error.issues);
    req.body = r.data;
    next();
  };
