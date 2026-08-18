import { AppError, type ErrorCode } from "@kb/shared";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function ok(c: Context, data: unknown, status: ContentfulStatusCode = 200) {
  return c.json({ ok: true, data }, status);
}

export function err(c: Context, error: AppError) {
  return c.json(
    { ok: false, error: { code: error.code, message: error.message, fields: error.fields } },
    error.status as 400,
  );
}

export function onError(e: unknown, c: Context) {
  if (e instanceof AppError) return err(c, e);
  console.error(e);
  return c.json({ ok: false, error: { code: "VALIDATION" as ErrorCode, message: "服务器错误" } }, 500);
}
