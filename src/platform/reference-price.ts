import type { Cache } from "./cache.js";

/**
 * Spec 10.5 and the plan's Global Constraints: the house ladder quotes around Coinbase's
 * spot price, GET https://api.coinbase.com/v2/prices/{BASE}-USDT/spot, reply shaped
 * { "data": { "amount": "79924.965", "base": "BTC", "currency": "USDT" } }. Every market
 * this exchange lists quotes in USDT (assets.exponent 6), so the reply is parsed straight
 * into USDT minor units; there is no other quote asset to generalise the exponent for.
 */
export interface CoinbaseSpotReply {
  data?: { amount?: string };
}

export interface ReferencePriceDeps {
  cache: Cache;
}

const QUOTE_EXPONENT = 6;
const CACHE_TTL_SECONDS = 10;
const FETCH_TIMEOUT_MS = 3_000;
const AMOUNT_RE = /^([0-9]+)(?:\.([0-9]+))?$/;

/**
 * Parses a Coinbase style decimal amount ("79924.965") into minor units for the given
 * exponent, entirely in strings and bigints: the whole and fractional parts are split on
 * the dot, the fractional part padded with trailing zeros or truncated to exponent digits,
 * then the two parts are concatenated and read as one integer. No float ever touches this
 * value. Anything that is not a plain, non-negative decimal string, including empty input,
 * a sign, exponent notation, or leading and trailing whitespace, returns null rather than
 * throwing, so a malformed reply degrades to "no price known" instead of a crash.
 */
export function parseSpotAmount(amount: string, exponent: number): bigint | null {
  const match = AMOUNT_RE.exec(amount);
  if (!match) return null;
  const whole = match[1] ?? "0";
  const frac = (match[2] ?? "").slice(0, exponent).padEnd(exponent, "0");
  return BigInt(whole + frac);
}

function baseAssetOf(market: string): string {
  return market.split("-")[0] ?? market;
}

/**
 * fetchReferencePrice(market, deps, fetchImpl): the reference price for one market, in
 * quote minor units per whole base unit, or null when nothing usable is known right now.
 * Checks deps.cache first (Redis in production, memory in tests, ten second ttl); on a
 * miss it calls Coinbase, bounded by a three second AbortController timeout, and caches a
 * successful parse before returning it. Any failure along the way, a network error, a
 * non OK response, a reply that does not parse, or the request timing out, returns null
 * without touching the cache: the caller (ensureFreshLadder, src/routes/exchange-house.ts)
 * keeps whatever reference_price the market already has stored rather than treating a
 * fetch failure as "the price is now unknown".
 */
export async function fetchReferencePrice(
  market: string,
  deps: ReferencePriceDeps,
  fetchImpl: typeof fetch = fetch,
): Promise<bigint | null> {
  const cacheKey = `reference_price:${market}`;
  const cached = await deps.cache.get(cacheKey);
  if (cached !== null) {
    try {
      return BigInt(cached);
    } catch {
      // Not a valid cached value; fall through and fetch fresh rather than fail the call.
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `https://api.coinbase.com/v2/prices/${baseAssetOf(market)}-USDT/spot`;
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as CoinbaseSpotReply;
    const amount = body.data?.amount;
    if (typeof amount !== "string") return null;
    const parsed = parseSpotAmount(amount, QUOTE_EXPONENT);
    if (parsed === null) return null;
    await deps.cache.set(cacheKey, parsed.toString(), CACHE_TTL_SECONDS);
    return parsed;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
