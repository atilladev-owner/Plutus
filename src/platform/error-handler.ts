import type { ErrorRequestHandler, RequestHandler } from "express";
import { ApiError } from "../domain/errors.js";
import { mapDbError } from "../db/errors.js";
import { captureError } from "./sentry.js";
import type { Logger } from "./logger.js";

const TITLES: Record<number, string> = {
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict",
  413: "Payload Too Large", 415: "Unsupported Media Type", 422: "Unprocessable Content", 429: "Too Many Requests",
  500: "Internal Server Error", 503: "Service Unavailable",
};

export function sendProblem(res: import("express").Response, err: ApiError): void {
  const body = {
    type: `https://plutus.atilladev.com/errors/${err.code}`,
    title: TITLES[err.status] ?? "Error",
    status: err.status,
    detail: err.message,
    code: err.code,
    request_id: res.locals.requestId as string,
    ...(err.errors ? { errors: err.errors } : {}),
  };
  if (err.headers) for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
  res.status(err.status).type("application/problem+json").send(JSON.stringify(body));
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  sendProblem(res, new ApiError(404, "not_found", "no such route"));
};

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    if (res.headersSent) return;
    if (err instanceof ApiError) return sendProblem(res, err);
    const mapped = mapDbError(err);
    if (mapped) return sendProblem(res, mapped);
    const e = err as { type?: string; status?: number; message?: string };
    if (e?.type === "entity.parse.failed") return sendProblem(res, new ApiError(400, "validation_failed", "the request body is not valid JSON"));
    if (e?.type === "entity.too.large") return sendProblem(res, new ApiError(413, "payload_too_large", "the request body exceeds 64 KB"));
    const requestId = res.locals.requestId as string;
    logger.error({ request_id: requestId, err: e?.message ?? String(err) }, "unhandled");
    // Only this branch is a genuinely unexpected error: every ApiError above, and every
    // mapped DB error, is a refusal the caller already understands and handled.
    captureError(err, requestId);
    sendProblem(res, new ApiError(500, "internal_error", "something went wrong on our side; quote the request id"));
  };
}
