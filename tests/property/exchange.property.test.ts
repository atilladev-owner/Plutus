import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";
import request from "supertest";
import type { Express } from "express";
import { makeTestApp } from "../helpers/app.js";
import { mintKey } from "../helpers/keys.js";
import { resetExchangeBooks, verifyExchangeLedger } from "../helpers/exchange.js";
import { testPool } from "../helpers/db.js";
import { signRequest } from "../../src/platform/signing.js";
import { ensureFreshLadder } from "../../src/routes/exchange-house.js";
import { EXCHANGE_LEDGER_ID } from "../../src/db/exchange.js";
import type { RateLimiter } from "../../src/platform/ratelimit.js";

// Task 9: the randomised trading session, milestone two acceptance criterion 2 (spec
// docs/superpowers/specs/2026-09-04-plutus-design.md line 57) and section 6's invariants
// (lines 222 to 232). Model follows tests/property/ledger.property.test.ts from milestone
// one: rate limits are overridden the same way, one long fast-check sequence rather than
// many short ones, a fixed seed keeps a failure reproducible, and every assertion below is
// an exact bigint comparison, never a float. Every operation runs through the signed HTTP
// surface tests/integration/exchange-orders.test.ts already exercises, not the matching
// function directly (tests/integration/matching.test.ts proves that at the database layer
// already), so this is the same client a real trader would be.

interface Key { id: string; secret: string }

function sign(k: Key, method: string, path: string, body?: unknown): Record<string, string> {
  return signRequest({ keyId: k.id, secret: k.secret, method, path, timestamp: Date.now(), body: body !== undefined ? JSON.stringify(body) : undefined });
}

function place(app: Express, k: Key, body: Record<string, unknown>) {
  return request(app).post("/v1/exchange/orders").set(sign(k, "POST", "/v1/exchange/orders", body)).send(body);
}
function cancelById(app: Express, k: Key, id: string) {
  const path = `/v1/exchange/orders/${id}`;
  return request(app).delete(path).set(sign(k, "DELETE", path));
}

// The mint and sandbox rate limits exist to protect production from exactly the request
// volume this session generates, for a reason that has nothing to do with the exchange
// invariants under test; overridden the same way tests/property/ledger.property.test.ts
// overrides them for the ledger.
const noRateLimits: RateLimiter = { limit: async () => ({ ok: true, limit: 1_000_000, remaining: 1_000_000, resetAt: Date.now() + 1000 }) };

const MARKETS = ["BTC-USDT", "ETH-USDT"] as const;
type Market = (typeof MARKETS)[number];

// Fixed references, injected into ensureFreshLadder the way
// tests/integration/house.test.ts does, so the house's own ladder rests on the book at a
// known price for the whole session and every random order's price can be placed within a
// known band of it. Both already land on the shared 10,000 minor unit tick (spec 10.1).
const REFERENCE: Record<Market, bigint> = { "BTC-USDT": 80_000_000_000n, "ETH-USDT": 2_500_000_000n };
const LOT: Record<Market, bigint> = { "BTC-USDT": 100_000n, "ETH-USDT": 1_000_000n };
const TICK = 10_000n;
const BASE_DIVISOR = 100_000_000n; // 10 ** 8: both BTC and ETH exponent, db/migrations/0002_assets.sql.

function tickAligned(price: bigint): bigint {
  const remainder = price % TICK;
  return remainder === 0n ? price : price - remainder;
}

// A tick aligned price within five percent of the fixed reference: offsetBps ranges
// -500..500, five hundred basis points either side, the same bps convention exchange_fee
// already uses (db/migrations/0013_place_order.sql).
function priceFor(market: Market, offsetBps: number): bigint {
  const reference = REFERENCE[market];
  const delta = (reference * BigInt(offsetBps)) / 10_000n;
  return tickAligned(reference + delta);
}

function quoteAmountFor(market: Market, offsetBps: number, lots: number): bigint {
  const price = priceFor(market, offsetBps);
  const perLot = (price * LOT[market]) / BASE_DIVISOR;
  // A five percent buffer over the requested lots' own notional, comfortably covering the
  // taker fee and any price improvement across several resting levels, so a market buy this
  // size fills the number of lots it names whenever the book actually has them.
  return (perLot * BigInt(lots) * 105n) / 100n;
}

interface PlaceOp {
  kind: "place"; keyIdx: number; market: Market; side: "buy" | "sell"; type: "limit" | "market";
  timeInForce: "GTC" | "IOC" | "FOK"; postOnly: boolean; offsetBps: number; lots: number;
}
interface CancelOp { kind: "cancel"; keyIdx: number; pick: number }
type Op = PlaceOp | CancelOp;

const placeArb: fc.Arbitrary<PlaceOp> = fc.record({
  kind: fc.constant("place" as const),
  keyIdx: fc.nat({ max: 4 }),
  market: fc.constantFrom(...MARKETS),
  side: fc.constantFrom("buy" as const, "sell" as const),
  type: fc.constantFrom("limit" as const, "market" as const),
  timeInForce: fc.constantFrom("GTC" as const, "IOC" as const, "FOK" as const),
  postOnly: fc.boolean(),
  offsetBps: fc.integer({ min: -500, max: 500 }),
  lots: fc.integer({ min: 1, max: 5 }),
});
const cancelArb: fc.Arbitrary<CancelOp> = fc.record({
  kind: fc.constant("cancel" as const), keyIdx: fc.nat({ max: 4 }), pick: fc.nat({ max: 9_999 }),
});
// Roughly one cancel in ten, the brief's own session shape; the rest place an order.
const opArb: fc.Arbitrary<Op> = fc.oneof({ arbitrary: placeArb, weight: 9 }, { arbitrary: cancelArb, weight: 1 });

// One long sequence rather than many short ones (numRuns 1 below), a fixed length and a
// fixed seed so a failure reproduces exactly. 1,300 ops at a 9:1 place to cancel weight
// comfortably clears the spec's 1,000 order floor; the exact counts this seed produces are
// asserted below and recorded in the task report.
const SESSION_SEED = 424242;
const opsArb = fc.array(opArb, { minLength: 1_300, maxLength: 1_300 });

function fakeReferenceFetch(amount: string, base: string): typeof fetch {
  return (async () => ({ ok: true, json: async () => ({ data: { amount, base, currency: "USDT" } }) }) as unknown as Response) as unknown as typeof fetch;
}

describe("exchange invariants under a randomised trading session", () => {
  beforeAll(async () => {
    await resetExchangeBooks();
  });

  it("conserves money, keeps every hold and market sequence honest, across at least a thousand random orders", async () => {
    const { app, deps } = await makeTestApp({ limiter: noRateLimits });

    await fc.assert(fc.asyncProperty(opsArb, async (ops) => {
      // Reset first, inside the property, not only in beforeAll: a fast-check shrink
      // attempt after a failing run calls this function again with a different, usually
      // smaller, ops array, and each attempt needs the same clean starting book the first
      // one had, not whatever the previous attempt left behind.
      await resetExchangeBooks();

      const keys: Key[] = [];
      for (let i = 0; i < 5; i++) keys.push(await mintKey(app));
      for (const k of keys) {
        const res = await request(app).post("/v1/exchange/faucet").set(sign(k, "POST", "/v1/exchange/faucet")).send();
        expect(res.status).toBe(200);
      }

      // The house ladder, quoted once at a fixed reference the way
      // tests/integration/house.test.ts injects one, so every random price within five
      // percent of it has real liquidity to trade against from the very first order.
      await ensureFreshLadder(deps, "BTC-USDT", fakeReferenceFetch("80000", "BTC"));
      await ensureFreshLadder(deps, "ETH-USDT", fakeReferenceFetch("2500", "ETH"));

      const sessionStart = new Date();
      const openOrders: string[][] = [[], [], [], [], []];
      let placed = 0;
      let filled = 0;
      let cancelledByRequest = 0;
      let cancelledOnPlace = 0;
      const rejections: Record<string, number> = {};

      for (const op of ops) {
        const k = keys[op.keyIdx]!;
        if (op.kind === "cancel") {
          const list = openOrders[op.keyIdx]!;
          if (list.length === 0) continue;
          const orderId = list.splice(op.pick % list.length, 1)[0]!;
          const res = await cancelById(app, k, orderId);
          // An order this session itself opened can already be gone by the time its own
          // cancel op is drawn, filled by a later, unrelated crossing order, or already
          // cancelled by IOC/FOK on the placement that opened it: not_found or
          // order_not_open, never anything else.
          expect([200, 404, 409]).toContain(res.status);
          if (res.status === 200) cancelledByRequest++;
          continue;
        }

        const timeInForce = op.type === "market" ? "IOC" : op.timeInForce;
        const postOnly = op.type === "market" ? false : op.postOnly;
        const body: Record<string, unknown> = { market: op.market, side: op.side, type: op.type, time_in_force: timeInForce, post_only: postOnly };
        if (op.type === "limit") {
          body.price = priceFor(op.market, op.offsetBps).toString();
          body.quantity = (BigInt(op.lots) * LOT[op.market]).toString();
        } else if (op.side === "buy") {
          body.quote_amount = quoteAmountFor(op.market, op.offsetBps, op.lots).toString();
        } else {
          body.quantity = (BigInt(op.lots) * LOT[op.market]).toString();
        }

        const res = await place(app, k, body);
        placed++;
        expect([201, 422]).toContain(res.status);
        if (res.status === 201) {
          const status = res.body.status as string;
          if (status === "open" || status === "partially_filled") openOrders[op.keyIdx]!.push(res.body.id as string);
          else if (status === "filled") filled++;
          else if (status === "cancelled") cancelledOnPlace++;
        } else {
          expect(res.body.code).toBe("order_rejected");
          const reason = res.body.detail as string;
          rejections[reason] = (rejections[reason] ?? 0) + 1;
        }
      }

      const { rows: tradeCountRows } = await testPool().query<{ n: string }>(
        "select count(*)::text as n from trades where created_at >= $1", [sessionStart]);

      process.stdout.write(
        `exchange property session (seed ${SESSION_SEED}): placed ${placed}, filled ${filled}, ` +
        `cancelled by request ${cancelledByRequest}, cancelled on placement (ioc/fok/market remainder) ${cancelledOnPlace}, ` +
        `trades ${tradeCountRows[0]?.n ?? "0"}, rejections ${JSON.stringify(rejections)}\n`,
      );
      expect(placed).toBeGreaterThanOrEqual(1_000);

      // Assertion 1: verify's own hash chain, gapless journal sequence and full balance
      // replay, spec section 6 invariants 4 and 5.
      const report = await verifyExchangeLedger();
      expect(report).toMatchObject({ ok: true, chain_ok: true, sequence_ok: true, replay_matches: true });

      // Assertion 2: every asset sums to zero across every account in ldg_exchange,
      // world accounts included, spec section 6 invariant 1.
      const { rows: assetSums } = await testPool().query<{ asset: string; sum: string }>(
        "select asset, sum(balance)::text as sum from accounts where ledger_id = $1 group by asset", [EXCHANGE_LEDGER_ID]);
      expect(assetSums.length).toBeGreaterThan(0);
      for (const row of assetSums) expect(BigInt(row.sum)).toBe(0n);

      // Assertion 3: every account's held equals the sum of remaining on its own open
      // holds, spec section 6 invariant 3, checked for every normal account (every trading
      // key, the house's own three inventory accounts, and the fee account), not narrowed
      // to only the five keys this session minted.
      const { rows: accounts } = await testPool().query<{ id: string; held: string }>(
        "select id, held::text as held from accounts where ledger_id = $1 and kind = 'normal'", [EXCHANGE_LEDGER_ID]);
      expect(accounts.length).toBeGreaterThan(0);
      for (const a of accounts) {
        const { rows: holds } = await testPool().query<{ sum: string }>(
          "select coalesce(sum(remaining), 0)::text as sum from holds where account_id = $1 and status = 'open'", [a.id]);
        expect(BigInt(a.held)).toBe(BigInt(holds[0]!.sum));
      }

      // Assertion 4: every market's market_events sequence is gapless from one.
      for (const market of MARKETS) {
        const { rows } = await testPool().query<{ seq_text: string }>(
          "select seq::text as seq_text from market_events where market = $1 order by seq", [market]);
        expect(rows.length).toBeGreaterThan(0);
        rows.forEach((r, i) => expect(BigInt(r.seq_text)).toBe(BigInt(i + 1)));
      }

      // Assertion 5: every order with a fill has filled_quote and filled_quantity equal
      // to the sum of its own trades. Scoped to this run's own session start so an
      // unrelated earlier test file's own orders never enter the check; key_house is not
      // excluded, since a trader crossing the house ladder fills a real house order too.
      const { rows: filledOrders } = await testPool().query<{ id: string; filled_quantity: string; filled_quote: string }>(
        "select id, filled_quantity::text as filled_quantity, filled_quote::text as filled_quote from orders where filled_quantity > 0 and created_at >= $1",
        [sessionStart]);
      expect(filledOrders.length).toBeGreaterThan(0);
      for (const o of filledOrders) {
        const { rows: trades } = await testPool().query<{ quantity: string; notional: string }>(
          "select quantity::text as quantity, notional::text as notional from trades where buy_order_id = $1 or sell_order_id = $1", [o.id]);
        const qty = trades.reduce((sum, t) => sum + BigInt(t.quantity), 0n);
        const quote = trades.reduce((sum, t) => sum + BigInt(t.notional), 0n);
        expect(qty).toBe(BigInt(o.filled_quantity));
        expect(quote).toBe(BigInt(o.filled_quote));
      }

      // Assertion 6: a restatement of conservation for clarity. The house's own three
      // inventory accounts, every trader's own accounts, and the fee account together sum
      // to exactly the negative of the world account, per asset.
      const { rows: byKind } = await testPool().query<{ asset: string; name: string; balance: string }>(
        "select asset, name, balance::text as balance from accounts where ledger_id = $1 and kind in ('world', 'normal')", [EXCHANGE_LEDGER_ID]);
      const worldByAsset = new Map<string, bigint>();
      const restByAsset = new Map<string, bigint>();
      for (const row of byKind) {
        const amount = BigInt(row.balance);
        if (row.name === "world") worldByAsset.set(row.asset, (worldByAsset.get(row.asset) ?? 0n) + amount);
        else restByAsset.set(row.asset, (restByAsset.get(row.asset) ?? 0n) + amount);
      }
      expect(worldByAsset.size).toBeGreaterThan(0);
      for (const [asset, worldSum] of worldByAsset) {
        expect(restByAsset.get(asset) ?? 0n).toBe(-worldSum);
      }
    }), { numRuns: 1, seed: SESSION_SEED, endOnFailure: true });
  }, 300_000);
});
