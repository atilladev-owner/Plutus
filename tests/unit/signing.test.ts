import { describe, it, expect } from "vitest";
import { signRequest } from "../../src/platform/signing.js";

// Pinned vector: secret "unit-test-signing-secret", timestamp 1700000000000, POST,
// path /v1/exchange/orders, body {"a":1}. The HMAC key is sha256(secret), not the raw
// secret (see the module comment in signing.ts for why), computed once here with plain
// node:crypto so this test does not depend on signRequest to check itself.
const VECTOR_SIGNATURE = "a41b4aa9afb5af5f8a9901737a8ef63dd6b09a243d0434c3a5d4450cc320543b";
const VECTOR_SIGNATURE_TAMPERED = "6c023bf7ccdd9cba5b56921a33428ce59f36a58483e2b014bd3ec2e73cb78c61";

describe("signRequest", () => {
  it("pins a known vector", () => {
    const headers = signRequest({
      keyId: "key_test",
      secret: "unit-test-signing-secret",
      method: "POST",
      path: "/v1/exchange/orders",
      body: '{"a":1}',
      timestamp: 1700000000000,
    });
    expect(headers["X-Plutus-Signature"]).toBe(VECTOR_SIGNATURE);
    expect(headers["X-Plutus-Key-Id"]).toBe("key_test");
    expect(headers["X-Plutus-Timestamp"]).toBe("1700000000000");
    expect(headers["X-Plutus-Recv-Window"]).toBe("5000");
  });

  it("changes the signature when one byte of the body changes", () => {
    const base = { keyId: "key_test", secret: "unit-test-signing-secret", method: "POST", path: "/v1/exchange/orders", timestamp: 1700000000000 };
    const original = signRequest({ ...base, body: '{"a":1}' });
    const tampered = signRequest({ ...base, body: '{"a":2}' });
    expect(original["X-Plutus-Signature"]).toBe(VECTOR_SIGNATURE);
    expect(tampered["X-Plutus-Signature"]).toBe(VECTOR_SIGNATURE_TAMPERED);
    expect(tampered["X-Plutus-Signature"]).not.toBe(original["X-Plutus-Signature"]);
  });

  it("carries an explicit receive window through unchanged", () => {
    const headers = signRequest({ keyId: "k", secret: "s", method: "get", path: "/x", timestamp: 1, recvWindow: 10000 });
    expect(headers["X-Plutus-Recv-Window"]).toBe("10000");
    expect(headers["X-Plutus-Timestamp"]).toBe("1");
  });

  it("upper cases the method inside the signed message but not the header casing rules", () => {
    const lower = signRequest({ keyId: "k", secret: "s", method: "get", path: "/x", timestamp: 1 });
    const upper = signRequest({ keyId: "k", secret: "s", method: "GET", path: "/x", timestamp: 1 });
    expect(lower["X-Plutus-Signature"]).toBe(upper["X-Plutus-Signature"]);
  });

  it("defaults the body to an empty string when absent", () => {
    const withoutBody = signRequest({ keyId: "k", secret: "s", method: "GET", path: "/v1/exchange/balances", timestamp: 5 });
    const withEmptyBody = signRequest({ keyId: "k", secret: "s", method: "GET", path: "/v1/exchange/balances", timestamp: 5, body: "" });
    expect(withoutBody["X-Plutus-Signature"]).toBe(withEmptyBody["X-Plutus-Signature"]);
  });

  it("signs the query string as part of the path", () => {
    const withoutQuery = signRequest({ keyId: "k", secret: "s", method: "GET", path: "/v1/exchange/book", timestamp: 5 });
    const withQuery = signRequest({ keyId: "k", secret: "s", method: "GET", path: "/v1/exchange/book?depth=10", timestamp: 5 });
    expect(withoutQuery["X-Plutus-Signature"]).not.toBe(withQuery["X-Plutus-Signature"]);
  });
});
