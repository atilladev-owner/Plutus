import { describe, it, expect } from "vitest";
import { signPayload, verifySignature } from "../../src/platform/webhook-sign.js";

describe("webhook signatures", () => {
  it("signs and verifies inside the tolerance", () => {
    const body = '{"id":"evt_1"}';
    const t = 1_800_000_000;
    const header = `t=${t},v1=${signPayload("whsec", t, body)}`;
    expect(verifySignature("whsec", header, body, t + 100)).toBe(true);
    expect(verifySignature("whsec", header, body + " ", t + 100)).toBe(false);
    expect(verifySignature("other", header, body, t + 100)).toBe(false);
    expect(verifySignature("whsec", header, body, t + 301)).toBe(false);
    expect(verifySignature("whsec", "garbage", body, t)).toBe(false);
  });
});
