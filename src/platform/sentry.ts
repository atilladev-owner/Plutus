import * as Sentry from "@sentry/node";
import type { Config } from "../config.js";

let enabled = false;

/** Strips the authorization header, the cookie header and the request body from an event
 * before it leaves this process. Exported on its own so the scrubbing is tested directly,
 * without needing a live Sentry client. */
export function scrubEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.request?.headers) {
    delete event.request.headers.authorization;
    delete event.request.headers.cookie;
  }
  if (event.request) delete event.request.data;
  return event;
}

/** Starts Sentry only when a DSN is configured; local development and every test run pass
 * no DSN and never talk to Sentry. No performance tracing (tracesSampleRate: 0), and no
 * default PII collection: this is an error tracker, not a data collector. */
export function initSentry(config: Config): void {
  if (!config.SENTRY_DSN) return;
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.NODE_ENV,
    release: config.PLUTUS_VERSION,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend: scrubEvent,
  });
  enabled = true;
}

/** No-op unless initSentry has actually started the SDK, so a captured error never blocks
 * on a client that was never configured. Call only for unexpected (500) errors; an
 * ApiError is a refusal the caller already handled and is never sent here. */
export function captureError(err: unknown, requestId: string): void {
  if (!enabled) return;
  Sentry.captureException(err, { tags: { request_id: requestId } });
}
