import { describe, it, expect } from "vitest";
import { ApiError, notFound, validation } from "../../src/domain/errors.js";

describe("ApiError", () => {
  it("carries status, code and detail", () => {
    const e = new ApiError(409, "insufficient_funds", "leg 0 available 5");
    expect(e.status).toBe(409);
    expect(e.code).toBe("insufficient_funds");
    expect(e.message).toBe("leg 0 available 5");
  });
  it("has helpers", () => {
    expect(notFound("ledger").status).toBe(404);
    const v = validation("bad", [{ path: "legs.0.amount", message: "must be a minor unit string" }]);
    expect(v.status).toBe(422);
    expect(v.errors?.[0]?.path).toBe("legs.0.amount");
  });
});
