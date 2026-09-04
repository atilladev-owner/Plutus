import pino, { type Logger } from "pino";
import type { RequestHandler } from "express";

export type { Logger };

export function createLogger(level = "info"): Logger {
  return pino({
    level,
    base: undefined,
    redact: { paths: ["req.headers.authorization", "req.headers.cookie", "*.secret", "*.signature"], censor: "[redacted]" },
  });
}

/** One line per request: id, key id when known, route, status, latency. Never a body, never a secret. */
export function requestLog(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
      logger.info({
        request_id: res.locals.requestId as string,
        key_id: (res.locals.key as { id: string } | undefined)?.id ?? null,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        latency_ms: ms,
      });
    });
    next();
  };
}
