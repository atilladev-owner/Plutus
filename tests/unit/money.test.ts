import { describe, it, expect } from "vitest";
import { parseAmount, formatAmount, toDisplay, MAX_AMOUNT, AmountError } from "../../src/domain/money.js";

describe("parseAmount", () => {
  it("accepts a decimal string of minor units", () => {
    expect(parseAmount("100000000")).toBe(100000000n);
    expect(parseAmount("1")).toBe(1n);
  });
  it("rejects zero unless allowed", () => {
    expect(() => parseAmount("0")).toThrow(AmountError);
    expect(parseAmount("0", { allowZero: true })).toBe(0n);
  });
  it("rejects anything that is not a plain integer string", () => {
    for (const bad of ["", "-1", "1.5", "01", "1e3", " 1", "1 ", "abc", "1_000", "+1"]) {
      expect(() => parseAmount(bad), bad).toThrow(AmountError);
    }
  });
  it("rejects values above BIGINT", () => {
    expect(parseAmount(MAX_AMOUNT.toString())).toBe(MAX_AMOUNT);
    expect(() => parseAmount((MAX_AMOUNT + 1n).toString())).toThrow(AmountError);
  });
  it("formats and displays", () => {
    expect(formatAmount(1250n)).toBe("1250");
    expect(toDisplay(1250n, 2)).toBe("12.50");
    expect(toDisplay(5n, 2)).toBe("0.05");
    expect(toDisplay(100000000n, 8)).toBe("1.00000000");
    expect(toDisplay(7n, 0)).toBe("7");
  });
});
