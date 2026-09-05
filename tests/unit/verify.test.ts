import { describe, it, expect } from "vitest";
import { Replay } from "../../src/domain/verify.js";

const entry = (seq: number, kind: string, payload: Record<string, unknown>) => ({ seq: String(seq), kind, payload: { ...payload, seq, kind } });

describe("Replay", () => {
  it("reproduces balances and held from transfer and hold entries", () => {
    const r = new Replay();
    r.apply(entry(1, "transfer.posted", { transfer: { legs: [{ from: "w", to: "a", asset: "GHS", amount: "1000", from_hold: null }] } }));
    r.apply(entry(2, "hold.created", { hold: { id: "h1", account: "a", asset: "GHS", amount: "400" } }));
    r.apply(entry(3, "transfer.posted", { transfer: { legs: [{ from: "a", to: "b", asset: "GHS", amount: "150", from_hold: "h1" }] } }));
    r.apply(entry(4, "hold.released", { hold: { id: "h1", account: "a", asset: "GHS", amount: "250" } }));
    expect(r.balances.get("a")).toEqual({ balance: 850n, held: 0n, asset: "GHS" });
    expect(r.balances.get("b")).toEqual({ balance: 150n, held: 0n, asset: "GHS" });
    expect(r.balances.get("w")).toEqual({ balance: -1000n, held: 0n, asset: "GHS" });
    expect(r.sums().get("GHS")).toBe(0n);
  });
  it("ignores informational entries", () => {
    const r = new Replay();
    r.apply(entry(1, "hold.captured", { hold: { id: "h", account: "a", asset: "GHS", amount: "5" } }));
    expect(r.balances.size).toBe(0);
  });
});
