import { describe, it, expect } from "vitest";
import { canonicalJson, hashEntry, GENESIS_HASH } from "../../src/domain/canonical.js";

describe("canonicalJson", () => {
  it("sorts keys bytewise and strips whitespace, recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: "x", c: [true, null] } })).toBe('{"a":{"c":[true,null],"d":"x"},"b":1}');
  });
  it("escapes strings the way JSON does", () => {
    expect(canonicalJson({ s: 'q"\\\n\t\u0001' })).toBe('{"s":"q\\"\\\\\\n\\t\\u0001"}');
  });
  it("refuses non integer numbers", () => {
    expect(() => canonicalJson({ x: 1.5 })).toThrow();
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
  });
  it("keeps non ascii as is", () => {
    expect(canonicalJson({ s: "cedi ₵" })).toBe('{"s":"cedi ₵"}');
  });
});

describe("hashEntry", () => {
  it("matches a fixed vector", () => {
    const h = hashEntry(GENESIS_HASH, '{"a":1}');
    expect(h.toString("hex")).toBe("b06a229070741292512e8760f470dd7a4c46ccfdf253df781d88dabe58c1ccb1");
  });
  it("chains", () => {
    const h1 = hashEntry(GENESIS_HASH, '{"seq":1}');
    const h2 = hashEntry(h1, '{"seq":2}');
    expect(h2.equals(hashEntry(GENESIS_HASH, '{"seq":2}'))).toBe(false);
  });
});
