export type ErrorCode =
  | "validation_failed" | "unauthorized" | "forbidden_scope" | "not_found"
  | "insufficient_funds" | "asset_mismatch" | "hold_not_open"
  | "idempotency_key_reused" | "idempotency_in_flight" | "rate_limited"
  | "sandbox_limit_reached" | "rate_limiter_unavailable"
  | "invalid_signature" | "timestamp_out_of_window" | "order_rejected"
  | "unsupported_media_type" | "payload_too_large" | "internal_error";

export interface FieldError { path: string; message: string }

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    detail: string,
    public readonly errors?: FieldError[],
    public readonly headers?: Record<string, string>,
  ) {
    super(detail);
  }
}

export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found`);
export const validation = (detail: string, errors?: FieldError[]) => new ApiError(422, "validation_failed", detail, errors);
export const unauthorized = (detail = "a valid API key is required") => new ApiError(401, "unauthorized", detail);
