import "server-only";

/**
 * Minimal structured server logger.
 * JSON in production (ingest-friendly), readable lines in development.
 * Never log values that contain secrets or PII — pass redacted context.
 */

type Level = "debug" | "info" | "warn" | "error";

type Context = Record<string, unknown>;

function write(level: Level, message: string, context: Context = {}) {
  const entry = {
    level,
    msg: message,
    time: new Date().toISOString(),
    ...context,
  };

  const line =
    process.env.NODE_ENV === "production"
      ? JSON.stringify(entry)
      : `[${entry.time}] ${level.toUpperCase()} ${message}${
          Object.keys(context).length ? ` ${JSON.stringify(context)}` : ""
        }`;

  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  sink(line);
}

export const logger = {
  debug: (message: string, context?: Context) => write("debug", message, context),
  info: (message: string, context?: Context) => write("info", message, context),
  warn: (message: string, context?: Context) => write("warn", message, context),
  error: (message: string, context?: Context) => write("error", message, context),
};

/** Normalize unknown thrown values for safe logging. */
export function errorContext(error: unknown): Context {
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: error.message };
  }
  return { errorName: "UnknownError" };
}
