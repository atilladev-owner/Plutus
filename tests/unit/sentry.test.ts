import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Sentry from "@sentry/node";
import { initSentry, captureError, scrubEvent } from "../../src/platform/sentry.js";
import type { Config } from "../../src/config.js";

vi.mock("@sentry/node", () => ({ init: vi.fn(), captureException: vi.fn() }));

const baseConfig: Config = {
  NODE_ENV: "test", DATABASE_URL: "postgres://x", PUBLIC_BASE_URL: "http://localhost:3000",
  PLUTUS_VERSION: "1.2.3", PORT: 3000,
};

describe("sentry", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("beforeSend strips the authorization header, the cookie header and the request body", () => {
    const event = {
      request: { headers: { authorization: "Bearer secret", cookie: "s=1", host: "example.com" }, data: { amount: "100" } },
    } as unknown as Sentry.ErrorEvent;
    const scrubbed = scrubEvent(event);
    expect(scrubbed.request?.headers?.authorization).toBeUndefined();
    expect(scrubbed.request?.headers?.cookie).toBeUndefined();
    expect(scrubbed.request?.headers?.host).toBe("example.com");
    expect(scrubbed.request?.data).toBeUndefined();
  });

  it("captureError does nothing when no DSN is set", () => {
    initSentry({ ...baseConfig, SENTRY_DSN: undefined });
    captureError(new Error("boom"), "req_1");
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("a configured DSN starts the SDK and captureError then reports through it", () => {
    initSentry({ ...baseConfig, SENTRY_DSN: "https://key@sentry.example/1" });
    expect(Sentry.init).toHaveBeenCalledWith(expect.objectContaining({
      dsn: "https://key@sentry.example/1", environment: "test", release: "1.2.3", tracesSampleRate: 0, sendDefaultPii: false,
    }));
    const err = new Error("boom");
    captureError(err, "req_2");
    expect(Sentry.captureException).toHaveBeenCalledWith(err, { tags: { request_id: "req_2" } });
  });
});
