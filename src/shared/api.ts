
// Format response seragam (PRD bagian 12)
export type ApiOk<T> = { success: true; data: T; meta?: unknown };
export type ApiErr = { success: false; error: { code: string; message: string; details?: unknown } };
