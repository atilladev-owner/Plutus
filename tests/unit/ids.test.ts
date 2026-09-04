import { describe, it, expect } from "vitest";
import { newId, isId } from "../../src/domain/ids.js";

describe("ids", () => {
  it("makes prefixed 32 hex ids that never repeat", () => {
    const a = newId("ldg");
    const b = newId("ldg");
    expect(a).toMatch(/^ldg_[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
  it("recognises its own shape and nothing else", () => {
    expect(isId("acct", newId("acct"))).toBe(true);
    expect(isId("acct", newId("ldg"))).toBe(false);
    expect(isId("acct", "acct_short")).toBe(false);
    expect(isId("acct", "acct_" + "G".repeat(32))).toBe(false);
  });
});
