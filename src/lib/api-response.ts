import { toPublicError } from "@/lib/errors";
import { errorContext, logger } from "@/lib/logger";

/**
 * Uniform JSON contract for every route handler:
 *   success → { ok: true, data }
 *   failure → { ok: false, error: { code, message, details? } }
 */

export type ApiSuccess<T> = { ok: true; data: T };
export type ApiFailure = {
  ok: false;
  error: { code: string; message: string; details?: unknown };
};
export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export function apiOk<T>(data: T, init?: ResponseInit): Response {
  return Response.json({ ok: true, data } satisfies ApiSuccess<T>, init);
}

export function apiFail(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): Response {
  const body: ApiFailure = { ok: false, error: { code, message } };
  if (details !== undefined && process.env.NODE_ENV !== "production") {
    body.error.details = details;
  }
  return Response.json(body, { status });
}

/**
 * Wrap a route handler with consistent error handling: unexpected errors
 * are logged server-side and returned as production-safe messages.
 */
export function withErrorHandling<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
  routeName = "unknown-route",
): (...args: Args) => Promise<Response> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      const safe = toPublicError(error);
      if (safe.status >= 500) {
        logger.error("Unhandled route error", { route: routeName, ...errorContext(error) });
      }
      return apiFail(safe.status, safe.code, safe.message);
    }
  };
}
