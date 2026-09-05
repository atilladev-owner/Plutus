import { describe, it, expect } from "vitest";
import { generateSecret, hashSecret } from "../../src/platform/auth.js";

describe("secrets", () => {
  it("makes a prefixed base62 secret and a stable hash", () => {
    const k = generateSecret("test");
    expect(k.secret).toMatch(/^pl_test_[0-9A-Za-z]{43}$/);
    expect(k.prefix).toBe("pl_test");
    expect(k.last4).toBe(k.secret.slice(-4));
    expect(hashSecret(k.secret).equals(k.hash)).toBe(true);
    expect(hashSecret(k.secret + "x").equals(k.hash)).toBe(false);
  });

  it("is always exactly 43 base62 digits after the prefix, for a thousand draws each mode", () => {
    for (const mode of ["test", "live"] as const) {
      const re = new RegExp(`^pl_${mode}_[0-9A-Za-z]{43}$`);
      let previous: string | undefined;
      for (let i = 0; i < 1000; i++) {
        const k = generateSecret(mode);
        expect(k.secret).toHaveLength(8 + 43);
        expect(k.secret).toMatch(re);
        if (previous !== undefined) expect(k.secret).not.toBe(previous);
        previous = k.secret;
      }
    }
  });
});
