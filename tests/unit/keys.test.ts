import { describe, it, expect } from "vitest";
import { generateSecret, hashSecret } from "../../src/platform/auth.js";

describe("secrets", () => {
  it("makes a prefixed base62 secret and a stable hash", () => {
    const k = generateSecret("test");
    expect(k.secret).toMatch(/^pl_test_[0-9A-Za-z]{43,44}$/);
    expect(k.prefix).toBe("pl_test");
    expect(k.last4).toBe(k.secret.slice(-4));
    expect(hashSecret(k.secret).equals(k.hash)).toBe(true);
    expect(hashSecret(k.secret + "x").equals(k.hash)).toBe(false);
  });
});
