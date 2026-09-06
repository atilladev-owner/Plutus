import { describe, it, expect } from "vitest";
import { parseSpotAmount, fetchReferencePrice } from "../../src/platform/reference-price.js";
import { MemoryCache } from "../../src/platform/cache.js";

const USDT_EXPONENT = 6;

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

function countingFetch(body: unknown, ok = true): { calls: number; fetchImpl: typeof fetch } {
  const state = { calls: 0 };
  const fetchImpl = (async () => {
    state.calls++;
    return jsonResponse(body, ok);
  }) as unknown as typeof fetch;
  return { get calls() { return state.calls; }, fetchImpl };
}

function throwingFetch(): typeof fetch {
  return (async () => { throw new Error("network unreachable"); }) as unknown as typeof fetch;
}

describe("parseSpotAmount", () => {
  it("parses a fractional Coinbase amount into quote minor units", () => {
    expect(parseSpotAmount("79924.965", USDT_EXPONENT)).toBe(79924965000n);
  });
  it("pads a short fraction out to the exponent", () => {
    expect(parseSpotAmount("0.5", USDT_EXPONENT)).toBe(500000n);
  });
  it("returns null for anything that is not a plain decimal string", () => {
    expect(parseSpotAmount("garbage", USDT_EXPONENT)).toBeNull();
    for (const bad of ["", "-1", "1e3", " 1", "1 ", "1.2.3", "1,000"]) {
      expect(parseSpotAmount(bad, USDT_EXPONENT), bad).toBeNull();
    }
  });
  it("truncates a fraction longer than the exponent instead of rounding", () => {
    expect(parseSpotAmount("1.1234567", USDT_EXPONENT)).toBe(1123456n);
  });
  it("accepts a whole number with no fraction at all", () => {
    expect(parseSpotAmount("80000", USDT_EXPONENT)).toBe(80000000000n);
  });
});

describe("fetchReferencePrice", () => {
  it("parses the Coinbase reply and caches it for ten seconds", async () => {
    const cache = new MemoryCache();
    const fake = countingFetch({ data: { amount: "80000", base: "BTC", currency: "USDT" } });
    const first = await fetchReferencePrice("BTC-USDT", { cache }, fake.fetchImpl);
    expect(first).toBe(80000000000n);
    expect(fake.calls).toBe(1);

    // A second call inside the ten second cache window reads the cached value: the fake
    // fetch is never called again, even though it would return a different price now.
    const again = await fetchReferencePrice("BTC-USDT", { cache }, countingFetch({ data: { amount: "1" } }).fetchImpl);
    expect(again).toBe(80000000000n);
  });

  it("returns null and never throws when the fetch itself fails", async () => {
    const cache = new MemoryCache();
    const result = await fetchReferencePrice("BTC-USDT", { cache }, throwingFetch());
    expect(result).toBeNull();
  });

  it("returns null on a non OK response", async () => {
    const cache = new MemoryCache();
    const fake = countingFetch({}, false);
    const result = await fetchReferencePrice("BTC-USDT", { cache }, fake.fetchImpl);
    expect(result).toBeNull();
  });

  it("returns null when the reply has no usable amount", async () => {
    const cache = new MemoryCache();
    const fake = countingFetch({ data: {} });
    const result = await fetchReferencePrice("BTC-USDT", { cache }, fake.fetchImpl);
    expect(result).toBeNull();
  });
});
