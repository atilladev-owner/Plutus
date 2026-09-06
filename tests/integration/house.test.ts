import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import request from "supertest";
import { testPool } from "../helpers/db.js";
import { makeTestApp } from "../helpers/app.js";
import { resetExchangeBooks, verifyExchangeLedger } from "../helpers/exchange.js";
import { withTx } from "../../src/db/pool.js";
import { newId } from "../../src/domain/ids.js";
import { ensureFreshLadder } from "../../src/routes/exchange-house.js";
import { HOUSE_KEY_ID, exchangeFaucet, placeOrder, type PlaceOrderInput } from "../../src/db/exchange.js";

// The house ladder, spec 10.5. Mostly tested against ETH-USDT rather than BTC-USDT, with
// fake reference prices in ETH's own real range (2,500 USDT and neighbours), for two
// reasons. First, isolation: this file calls ensureFreshLadder directly with a fake fetch
// (there is no book endpoint yet, task 7 builds the reads that call this the same way),
// but tests/integration/exchange-orders.test.ts places real orders through the HTTP route,
// which now calls ensureFreshLadder with the real Coinbase fetch on every placement, in
// almost every one of its own scenarios, all on the same two markets this suite shares one
// database with. It touches ETH-USDT in exactly one of its own scenarios, against BTC-USDT
// in most of the rest, so choosing ETH-USDT here meaningfully narrows how often this file's
// own house_quoted_at writes can race a concurrent real refresh. Second, arithmetic: this
// file's own fake prices have to stay in the asset's own realistic range, because
// place_order computes a notional from price times quantity (0013_place_order.sql, amended
// by 0016_house_ladder.sql's exchange_notional to survive it), and a fake price many
// multiples of the real one, crossed with the ladder's own doubled quantities (up to
// sixteen times base_size at level 4), can still overflow the bigint range a notional
// itself is held to. 0.05 BTC and 1 ETH (spec 10.5's own base sizes) both keep that
// product's actual notional comfortably inside range against their own asset's real price;
// 80,000 USDT is that range for BTC, not for ETH. The one scenario below run against
// BTC-USDT at 80,000 USDT is the task brief's own worked example, kept as one focused,
// fast test to keep its own exposure to that same race small.
//
// Every scenario forces its own known starting point directly (house_quoted_at set to null
// or to a fixed number of seconds ago) rather than relying on a previous test's state, so
// the file does not depend on running its own tests in order either.

const MARKET = "ETH-USDT";
const HOUSE_ETH_BASE_SIZE = 100_000_000n; // 1 ETH, exponent 8, spec 10.5.
const HOUSE_BTC_BASE_SIZE = 5_000_000n; // 0.05 BTC, exponent 8, spec 10.5.
const TICK = 10_000n; // 0.01 USDT, spec 10.1, the same tick on both markets.

interface LadderRow { side: string; price: string; quantity: string }

function fakeFetch(amount: string, counter: { n: number }, base = "ETH"): typeof fetch {
  return (async () => {
    counter.n++;
    return { ok: true, json: async () => ({ data: { amount, base, currency: "USDT" } }) } as unknown as Response;
  }) as unknown as typeof fetch;
}

function failingFetch(counter: { n: number }): typeof fetch {
  return (async () => {
    counter.n++;
    throw new Error("coinbase unreachable");
  }) as unknown as typeof fetch;
}

async function forceHouseQuotedAt(market: string, secondsAgo: number | null): Promise<void> {
  if (secondsAgo === null) {
    await testPool().query("update markets set house_quoted_at = null where symbol = $1", [market]);
    return;
  }
  await testPool().query(
    "update markets set house_quoted_at = now() - ($2::text || ' seconds')::interval where symbol = $1",
    [market, secondsAgo.toString()]);
}

async function houseOrders(market: string): Promise<LadderRow[]> {
  const { rows } = await testPool().query<LadderRow>(
    `select side, price::text as price, quantity::text as quantity from orders
     where key_id = $1 and market = $2 and status in ('open', 'partially_filled')
     order by side, price::bigint`,
    [HOUSE_KEY_ID, market]);
  return rows;
}

async function sandboxKey(): Promise<string> {
  const id = newId("key");
  const hash = createHash("sha256").update(randomBytes(32)).digest();
  await testPool().query(
    "insert into api_keys (id, secret_hash, prefix, last4, mode, scopes) values ($1, $2, 'pl_test', 'abcd', 'test', '{exchange:trade}')",
    [id, hash]);
  return id;
}

/**
 * The hand computed ladder, spec 10.5: level i in 0..4 sits at the reference minus (bids)
 * or plus (asks) (10 + 5i) bps, rounded to the 0.01 USDT tick, down for bids and up for
 * asks, quantity baseSize doubling every level (1 ETH, or 0.05 BTC for the one BTC-USDT
 * scenario below). A direct transliteration of refresh_house_ladder's own arithmetic
 * (db/migrations/0016_house_ladder.sql), which is enough to pin the staleness and caching
 * behaviour every scenario below actually exercises; the one place a bug in the SQL and a
 * matching bug here could both hide, whether the rounding direction is actually right, is
 * spot checked by hand against level 0 in the rounding scenario below instead of trusted
 * to this function.
 */
function expectedLadder(referenceMinor: bigint, baseSize: bigint = HOUSE_ETH_BASE_SIZE): LadderRow[] {
  const rows: LadderRow[] = [];
  let qty = baseSize;
  for (let i = 0; i < 5; i++) {
    const bps = BigInt(10 + 5 * i);
    const delta = (referenceMinor * bps) / 10000n;
    const bidRaw = referenceMinor - delta;
    const bid = bidRaw - (bidRaw % TICK);
    const askRaw = referenceMinor + delta;
    const askRemainder = askRaw % TICK;
    const ask = askRemainder === 0n ? askRaw : askRaw + (TICK - askRemainder);
    rows.push({ side: "buy", price: bid.toString(), quantity: qty.toString() });
    rows.push({ side: "sell", price: ask.toString(), quantity: qty.toString() });
    qty *= 2n;
  }
  return rows.sort((a, b) => (a.side === b.side ? Number(BigInt(a.price) - BigInt(b.price)) : a.side.localeCompare(b.side)));
}

describe("the house ladder", () => {
  // Cross file contamination: matching.test.ts, exchange-orders.test.ts,
  // market-data.test.ts, exchange-wallet.test.ts and sweep.test.ts all trade the same
  // shared BTC-USDT and ETH-USDT books this file quotes against. beforeAll starts this
  // file with clean books the same way every other exchange test file does; afterAll
  // clears the ladder and fake reference price this file itself leaves behind (a real
  // house ladder resting, and a reference_price such as 80,000 USDT on ETH-USDT with an
  // old house_quoted_at) so the next file to run sees an unquoted house rather than this
  // one's own scenario.
  beforeAll(async () => {
    await resetExchangeBooks();
  });

  afterAll(async () => {
    await resetExchangeBooks();
  });

  it("quotes five bids and five asks at the spec prices, does not refetch inside fifteen seconds, and refetches once stale again", async () => {
    const counter = { n: 0 };

    await forceHouseQuotedAt(MARKET, null);
    const { deps: deps1 } = await makeTestApp();
    await ensureFreshLadder(deps1, MARKET, fakeFetch("2500", counter));
    expect(counter.n).toBe(1);
    expect(await houseOrders(MARKET)).toEqual(expectedLadder(2_500_000_000n));

    // Immediately again, still inside the fifteen second window and still deps1's own
    // reference price cache: the fake below would answer a very different price if it
    // were ever called; an unchanged ladder and call count is exactly how this proves the
    // fetch never ran a second time.
    await ensureFreshLadder(deps1, MARKET, fakeFetch("1", counter));
    expect(counter.n).toBe(1);
    expect(await houseOrders(MARKET)).toEqual(expectedLadder(2_500_000_000n));

    // Sixteen seconds old, forced directly rather than waited for in real time: the shared
    // database this ladder lives in has other files trading on it too, and a real clock
    // wait would only add flakiness a direct update does not. Fresh deps here, and so a
    // fresh (empty) reference price cache: house_quoted_at was faked stale without any
    // real time actually passing, so deps1's own ten second cache is still genuinely warm
    // and would otherwise answer 2,500 again on its own, proving nothing about whether the
    // fifteen second gate itself reopened.
    await forceHouseQuotedAt(MARKET, 16);
    const { deps: deps2 } = await makeTestApp();
    await ensureFreshLadder(deps2, MARKET, fakeFetch("2600", counter));
    expect(counter.n).toBe(2);
    expect(await houseOrders(MARKET)).toEqual(expectedLadder(2_600_000_000n));
  });

  it("keeps the previous ladder when the reference fetch fails", async () => {
    await forceHouseQuotedAt(MARKET, null);
    const { deps: deps1 } = await makeTestApp();
    const okCounter = { n: 0 };
    await ensureFreshLadder(deps1, MARKET, fakeFetch("2700", okCounter));
    const established = await houseOrders(MARKET);
    expect(established).toEqual(expectedLadder(2_700_000_000n));

    // Fresh deps again, and so a fresh reference price cache: without it, this call would
    // answer 2,700 again straight from deps1's still warm ten second cache (no real time
    // passed) without ever calling the failing fetch below, which would prove nothing
    // about refresh_house_ladder's own fallback (spec 10.5), the market's stored
    // reference_price, rather than fetchReferencePrice's cache, keeping the ladder put.
    await forceHouseQuotedAt(MARKET, 16);
    const { deps: deps2 } = await makeTestApp();
    const failCounter = { n: 0 };
    await ensureFreshLadder(deps2, MARKET, failingFetch(failCounter));
    expect(failCounter.n).toBe(1);
    expect(await houseOrders(MARKET)).toEqual(established);
  });

  it("rounds the ladder to the tick, down for bids and up for asks, when the reference does not land on one", async () => {
    const { deps } = await makeTestApp();
    const counter = { n: 0 };

    await forceHouseQuotedAt(MARKET, null);
    await ensureFreshLadder(deps, MARKET, fakeFetch("2499.97", counter));
    const orders = await houseOrders(MARKET);
    expect(orders).toEqual(expectedLadder(2_499_970_000n));

    // Level 0 by hand: reference 2,499,970,000; delta = reference * 10 / 10000 = 2,499,970.
    // bid raw = 2,497,470,030, which is 30 above the tick below it, so it rounds down to
    // 2,497,470,000. ask raw = 2,502,469,970, which is 30 short of the tick above it, so it
    // rounds up to 2,502,470,000. Neither lands on a tick by chance, which is exactly what
    // makes this the scenario that proves the rounding direction, not only the formula
    // either side of it.
    const bids = orders.filter((o) => o.side === "buy").sort((a, b) => Number(BigInt(b.price) - BigInt(a.price)));
    const asks = orders.filter((o) => o.side === "sell").sort((a, b) => Number(BigInt(a.price) - BigInt(b.price)));
    expect(bids[0]?.price).toBe("2497470000");
    expect(asks[0]?.price).toBe("2502470000");
  });

  it("fills a trader's market buy against the house, and the exchange ledger still verifies", async () => {
    const { deps } = await makeTestApp();
    const counter = { n: 0 };

    await forceHouseQuotedAt(MARKET, null);
    await ensureFreshLadder(deps, MARKET, fakeFetch("2500", counter));

    const trader = await sandboxKey();
    await withTx(testPool(), (c) => exchangeFaucet(c, trader));

    // The house's best (level 0) ask sits at 2,502,500,000 for 1 ETH (100,000,000 minor
    // units). This market buy spends exactly enough quote to take one lot of it, 0.01 ETH
    // (1,000,000 minor units): notional = 2,502,500,000 * 1,000,000 / 10^8 = 25,025,000;
    // taker fee = ceil(25,025,000 * 10 / 10000) = 25,025; total quote = 25,050,025. Two
    // lots would need 50,100,050, more than this order offers, so exactly one fills.
    const input: PlaceOrderInput = {
      keyId: trader, market: MARKET, clientOrderId: null, side: "buy", type: "market",
      timeInForce: "IOC", postOnly: false, price: null, quantity: null, quoteAmount: "25050025",
    };
    const result = await placeOrder(testPool(), input);
    expect(result.order.status).toBe("filled");
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({
      price: "2502500000", quantity: "1000000", notional: "25025000",
      buyer_fee: "25025", seller_fee: "25025",
    });

    const report = await verifyExchangeLedger();
    expect(report).toMatchObject({ ok: true, chain_ok: true, sequence_ok: true, replay_matches: true });
  });

  // The task brief's own worked example: a fake fetch answering 80,000 USDT for BTC-USDT.
  // Reference 80,000,000,000: level i's bps is 10 + 5i, delta = reference * bps / 10000.
  // i=0: delta 80,000,000, bid 79,920,000,000, ask 80,080,000,000, qty 5,000,000 (0.05 BTC).
  // i=1: delta 120,000,000, bid 79,880,000,000, ask 80,120,000,000, qty 10,000,000.
  // i=2: delta 160,000,000, bid 79,840,000,000, ask 80,160,000,000, qty 20,000,000.
  // i=3: delta 200,000,000, bid 79,800,000,000, ask 80,200,000,000, qty 40,000,000.
  // i=4: delta 240,000,000, bid 79,760,000,000, ask 80,240,000,000, qty 80,000,000.
  // Every one of those already lands on a multiple of the 10,000 tick, so this scenario, on
  // its own, cannot tell a correct rounding direction from none at all; the ETH-USDT
  // rounding scenario above, at a reference chosen specifically to land off tick, is what
  // actually proves that. One focused test on the real pair the brief's own example names,
  // not a whole second copy of every scenario above: BTC-USDT is the market
  // exchange-orders.test.ts touches in almost every one of its own scenarios, so this is
  // deliberately the file's only use of it, kept short to keep its own exposure to a
  // concurrent real refresh small.
  it("quotes the exact spec 10.5 ladder for a reference of 80,000 USDT on BTC-USDT", async () => {
    const counter = { n: 0 };
    await forceHouseQuotedAt("BTC-USDT", null);
    const { deps } = await makeTestApp();
    await ensureFreshLadder(deps, "BTC-USDT", fakeFetch("80000", counter, "BTC"));
    expect(counter.n).toBe(1);
    expect(await houseOrders("BTC-USDT")).toEqual(expectedLadder(80_000_000_000n, HOUSE_BTC_BASE_SIZE));
  });

  // A failure inside refresh_house_ladder itself, not only a failed fetch, must never
  // reach a caller. A reference this far under ETH-USDT's own real range rejects the
  // house's own level 0 bid as below_min_notional (spec 10.1's own floor is 5,000,000
  // minor USDT units): at 1 USDT the bid rounds to 990,000 quote minor units for a full
  // one ETH lot, comfortably under that floor, so refresh_house_ladder's own place_order
  // call raises order_rejected before house_quoted_at is ever stamped by the attempt
  // itself. resetExchangeBooks starts this scenario from an empty ETH-USDT book, so the
  // rejection's own rollback (it undoes the ladder cancel refresh_house_ladder ran before
  // placing anything new, along with everything after it) has nothing earlier to restore
  // either.
  it("stamps house_quoted_at and still answers a public book read when the house's own ladder placement is rejected", async () => {
    await resetExchangeBooks();
    await forceHouseQuotedAt(MARKET, null);
    const counter = { n: 0 };
    const { app, deps } = await makeTestApp();

    await ensureFreshLadder(deps, MARKET, fakeFetch("1", counter));
    expect(counter.n).toBe(1);
    expect(await houseOrders(MARKET)).toEqual([]);

    const { rows } = await testPool().query<{ house_quoted_at: string | null }>(
      "select house_quoted_at from markets where symbol = $1", [MARKET]);
    expect(rows[0]?.house_quoted_at).not.toBeNull();

    const res = await request(app).get(`/v1/exchange/markets/${MARKET}/book`);
    expect(res.status).toBe(200);
  });
});
