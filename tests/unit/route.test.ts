import { describe, it, expect } from "vitest";
import { toExpressPath, parsePage } from "../../src/platform/route.js";
import { encodeCursor } from "../../src/domain/cursor.js";

describe("route helpers", () => {
  it("converts OpenAPI paths to Express paths", () => {
    expect(toExpressPath("/v1/ledgers/{id}/holds/{holdId}")).toBe("/v1/ledgers/:id/holds/:holdId");
  });
  it("parses pages and rejects a forged cursor", () => {
    expect(parsePage({ limit: 5 })).toEqual({ limit: 5, cursor: null });
    expect(parsePage({ limit: 5, cursor: encodeCursor({ t: "x", id: "y" }) })).toEqual({ limit: 5, cursor: { t: "x", id: "y" } });
    expect(() => parsePage({ limit: 5, cursor: "zzz" })).toThrow();
  });
});
