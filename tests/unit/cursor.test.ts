import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor } from "../../src/domain/cursor.js";

describe("cursor", () => {
  it("round trips", () => {
    const c = { t: "2026-09-04T10:00:00.000Z", id: "ldg_" + "a".repeat(32) };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });
  it("is opaque and rejects garbage", () => {
    expect(encodeCursor({ t: "x", id: "y" })).not.toContain("{");
    expect(decodeCursor("not-a-cursor")).toBeNull();
    expect(decodeCursor(Buffer.from('{"t":1}').toString("base64url"))).toBeNull();
  });
});
