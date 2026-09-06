import { withTx } from "../db/pool.js";
import * as X from "../db/exchange.js";
import { fetchReferencePrice } from "../platform/reference-price.js";
import type { AppDeps } from "../deps.js";

const STALE_MS = 15_000;

function isFresh(quotedAt: Date | null, now: number): boolean {
  return quotedAt !== null && now - quotedAt.getTime() < STALE_MS;
}

/**
 * Stands in for the real Coinbase fetch under NODE_ENV=test, for every caller that does
 * not pass its own fetchImpl: real crypto prices sit at real crypto prices, tens of
 * thousands of dollars per BTC, tens of billions in this exchange's own minor units, and a
 * house bid or ask actually resting at one of those on the shared test database would
 * outrank, on price alone, literally every order any other exchange test file places at
 * the small, hand computed prices those files were written against; matching is price time
 * priority, and a book's best bid always fills first regardless of which order arrived
 * expecting to be the one that does. A rejected fetch here degrades exactly the way a real
 * network failure already does (fetchReferencePrice returns null, refresh_house_ladder
 * keeps the market's own stored reference_price, which stays null on a fresh database, so
 * quoting is skipped rather than attempted at a garbage price): the difference is this one
 * never touches a socket, so exchange-orders.test.ts and every future test that places an
 * order through the HTTP route without meaning to exercise the house at all keeps the
 * empty book those tests were written against. A test that does want the house quoting
 * something specific, tests/integration/house.test.ts and the sweep's own coverage of it,
 * passes its own fetchImpl explicitly and reaches this function's real behaviour exactly
 * the way production does.
 */
async function testFetchDisabled(): Promise<Response> {
  throw new Error("network access is disabled under NODE_ENV=test; pass fetchImpl explicitly to reach it");
}

/**
 * Spec 10.5: the house has no loop, it quotes when someone is looking. Called before any
 * book, ticker, trades or candles read (task 7) and before every order placement
 * (src/routes/exchange-orders.ts), refreshing the house's ladder on market when
 * house_quoted_at is null or older than fifteen seconds.
 *
 * Two short transactions, not one held across the fetch: the first takes the market lock
 * only long enough to decide staleness. The reference price fetch then runs with no lock
 * held at all, since it can take up to three seconds (fetchReferencePrice's own Coinbase
 * timeout) and a placement or a read should never wait on Coinbase while holding the lock
 * every other request on this market needs. The second transaction takes the lock again,
 * re-checks staleness, since another request may have refreshed the ladder while this one
 * was fetching, and only then calls refresh_house_ladder. A market this call does not
 * recognise (an unknown symbol reaching it from a read endpoint's path segment) is treated
 * as never stale rather than an error: there is nothing to quote.
 */
export async function ensureFreshLadder(
  deps: AppDeps, market: string, fetchImpl?: typeof fetch,
): Promise<void> {
  const impl = fetchImpl ?? (deps.config.NODE_ENV === "test" ? testFetchDisabled : fetch);
  const checkedAt = Date.now();
  const staleNow = await withTx(deps.pool, async (c) => {
    await X.lockMarkets(c, [market]);
    const row = await X.getMarket(c, market);
    return row !== null && !isFresh(row.house_quoted_at, checkedAt);
  });
  if (!staleNow) return;

  const reference = await fetchReferencePrice(market, deps, impl);
  const now = new Date();

  await withTx(deps.pool, async (c) => {
    await X.lockMarkets(c, [market]);
    const row = await X.getMarket(c, market);
    if (!row || isFresh(row.house_quoted_at, now.getTime())) return;
    await c.query("select refresh_house_ladder($1, $2::bigint, $3)", [market, reference, now]);
  });
}
