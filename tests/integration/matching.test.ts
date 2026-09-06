import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { testPool } from "../helpers/db.js";
import { verifyExchangeLedger } from "../helpers/exchange.js";
import { withTx } from "../../src/db/pool.js";
import { newId } from "../../src/domain/ids.js";
import { mapDbError } from "../../src/db/errors.js";
import * as L from "../../src/db/ledger.js";
import {
  EXCHANGE_LEDGER_ID, exchangeFaucet, placeOrder, cancelOrder,
  type PlaceOrderInput, type OrderRow, type TradeRow,
} from "../../src/db/exchange.js";

// The matching function under test, db/migrations/0013_place_order.sql. Every amount
// below is computed by hand in the comment above the scenario that needs it, in minor
// units, and asserted as an exact bigint equality: no float ever touches money here.

async function sandboxKey(): Promise<string> {
  const id = newId("key");
  const hash = createHash("sha256").update(randomBytes(32)).digest();
  await testPool().query(
    "insert into api_keys (id, secret_hash, prefix, last4, mode, scopes) values ($1, $2, 'pl_test', 'abcd', 'test', '{exchange:trade}')",
    [id, hash]);
  return id;
}

async function fundedKey(): Promise<string> {
  const id = await sandboxKey();
  await withTx(testPool(), (c) => exchangeFaucet(c, id));
  return id;
}

interface Balance { balance: bigint; held: bigint }

async function balancesOf(keyId: string): Promise<Record<string, Balance>> {
  const { rows } = await testPool().query<{ asset: string; balance: string; held: string }>(
    "select asset, balance::text as balance, held::text as held from accounts where ledger_id = $1 and name = $2 and kind = 'normal'",
    [EXCHANGE_LEDGER_ID, keyId]);
  const out: Record<string, Balance> = {};
  for (const r of rows) out[r.asset] = { balance: BigInt(r.balance), held: BigInt(r.held) };
  return out;
}

async function feeAccountBalance(): Promise<bigint> {
  const { rows } = await testPool().query<{ balance: string }>(
    "select balance::text as balance from accounts where ledger_id = $1 and name = 'fee:USDT' and asset = 'USDT'",
    [EXCHANGE_LEDGER_ID]);
  return BigInt(rows[0]?.balance ?? "0");
}

async function holdOf(holdId: string | null): Promise<{ status: string; remaining: string; amount: string }> {
  const { rows } = await testPool().query<{ status: string; remaining: string; amount: string }>(
    "select status, remaining::text as remaining, amount::text as amount from holds where id = $1", [holdId]);
  return rows[0] as { status: string; remaining: string; amount: string };
}

async function orderRow(id: string): Promise<OrderRow | null> {
  const { rows } = await testPool().query<OrderRow>("select * from orders where id = $1", [id]);
  return rows[0] ?? null;
}

async function journalHasKind(entityId: string, kind: string): Promise<boolean> {
  const { rows } = await testPool().query<{ n: string }>(
    "select count(*)::text as n from journal where ledger_id = $1 and entity_id = $2 and kind = $3",
    [EXCHANGE_LEDGER_ID, entityId, kind]);
  return Number(rows[0]?.n ?? "0") > 0;
}

/** The ledger invariant close_order_hold must never break: an account's held column always
 * equals the sum of what its still open holds have left, whether a hold just closed as
 * captured (some of it spent) or as released (none of it was). */
async function expectHeldMatchesOpenHolds(keyId: string): Promise<void> {
  const { rows: accounts } = await testPool().query<{ id: string; held: string }>(
    "select id, held::text as held from accounts where ledger_id = $1 and name = $2 and kind = 'normal'",
    [EXCHANGE_LEDGER_ID, keyId]);
  for (const a of accounts) {
    const { rows: holds } = await testPool().query<{ sum: string }>(
      "select coalesce(sum(remaining), 0)::text as sum from holds where account_id = $1 and status = 'open'", [a.id]);
    expect(BigInt(a.held)).toBe(BigInt(holds[0]?.sum ?? "0"));
  }
}

async function holdsCountFor(keyId: string): Promise<number> {
  const { rows } = await testPool().query<{ n: string }>(
    "select count(*)::text as n from holds where account_id in (select id from accounts where ledger_id = $1 and name = $2)",
    [EXCHANGE_LEDGER_ID, keyId]);
  return Number(rows[0]?.n ?? "0");
}

async function marketEventsGapless(market: string): Promise<boolean> {
  // order by the real bigint column, not the text alias: naming the cast column "seq" too
  // would let Postgres bind the order by to that alias instead and sort lexicographically
  // ("1", "10", "2", ...), which is exactly the kind of bug this check exists to catch, so
  // it must not have one of its own.
  const { rows } = await testPool().query<{ seq_text: string }>(
    "select seq::text as seq_text from market_events where market = $1 order by seq", [market]);
  return rows.every((r, i) => BigInt(r.seq_text) === BigInt(i + 1));
}

async function expectLedgerOk(): Promise<void> {
  const report = await verifyExchangeLedger();
  expect(report).toMatchObject({ ok: true, chain_ok: true, sequence_ok: true, replay_matches: true });
}

function limitOrder(over: Partial<PlaceOrderInput> & { keyId: string; market: string; side: "buy" | "sell" }): PlaceOrderInput {
  return {
    clientOrderId: null, type: "limit", timeInForce: "GTC", postOnly: false,
    price: null, quantity: null, quoteAmount: null, ...over,
  };
}

async function rejectedDetail(p: Promise<unknown>): Promise<string | undefined> {
  const err = await p.catch((e: unknown) => e);
  const mapped = mapDbError(err);
  expect(mapped?.code).toBe("order_rejected");
  return mapped?.message;
}

describe("place_order and cancel_order", () => {
  let keyA: string;
  let keyB: string;
  let keyC: string;

  beforeAll(async () => {
    keyA = await fundedKey();
    keyB = await fundedKey();
    keyC = await fundedKey();
  });

  // Every scenario is a self contained financial event: verify's global invariants (the
  // hash chain, and every asset summing to zero across the whole ledger) must survive it,
  // and both markets' per market event sequence must stay gapless, whether the scenario
  // accepted, filled, cancelled or rejected an order.
  afterEach(async () => {
    await expectLedgerOk();
    expect(await marketEventsGapless("BTC-USDT")).toBe(true);
    expect(await marketEventsGapless("ETH-USDT")).toBe(true);
  });

  // Scenario (a). BTC-USDT: tick 10,000 (0.01 USDT), lot 100,000 (0.001 BTC), min notional
  // 5,000,000. price 8,000.00 USDT = 8,000,000,000 minor quote units, quantity 0.001 BTC =
  // 100,000 minor base units, 1 lot. notional = 8,000,000,000 * 100,000 / 10^8 = 8,000,000.
  // taker fee at 10 bps = ceil(8,000,000 * 10 / 10000) = 8,000. Hold = 8,008,000 USDT.
  it("(a) a limit buy rests on an empty book with a hold of notional plus fee, status open", async () => {
    const before = await balancesOf(keyA);
    const r = await placeOrder(testPool(), limitOrder({
      keyId: keyA, market: "BTC-USDT", side: "buy", price: "8000000000", quantity: "100000",
    }));
    expect(r.order.status).toBe("open");
    expect(r.order.filled_quantity).toBe("0");
    expect(r.trades).toEqual([]);
    const hold = await holdOf(r.order.hold_id);
    expect(hold).toMatchObject({ status: "open", amount: "8008000", remaining: "8008000" });
    const after = await balancesOf(keyA);
    expect(after.USDT!.balance).toBe(before.USDT!.balance);
    expect(after.USDT!.held - before.USDT!.held).toBe(8_008_000n);

    // Cancelled once its own assertions are done, so it cannot outrank scenario (b)'s own
    // resting buy on time priority: both would otherwise sit at the same price, and this
    // one, accepted first, would be the one a later crossing order matches instead.
    await withTx(testPool(), (c) => cancelOrder(c, keyA, r.order.id));
  });

  // Scenario (b). A limit sell for the exact same price and quantity crosses the resting
  // buy from (a) and fully consumes it in one trade. notional 8,000,000, fee 8,000 each
  // side (maker and taker are both 10 bps in this milestone, so the two are equal here).
  // leg1 (buyer hold to seller): 8,000,000 - 8,000 = 7,992,000. leg2 (buyer hold to fee):
  // 8,000 + 8,000 = 16,000. leg3 (seller hold to buyer): 100,000 base units. The buyer's
  // hold (8,008,000, from scenario a) is drawn by exactly leg1 + leg2 = 8,008,000, closing
  // it as captured with nothing left; the seller's hold (100,000) is drawn by exactly
  // leg3, closing it the same way.
  it("(b) a crossing limit sell fills at the resting price with three exact legs, closing both holds", async () => {
    const restBefore = await balancesOf(keyA);
    const rest = await placeOrder(testPool(), limitOrder({
      keyId: keyA, market: "BTC-USDT", side: "buy", price: "8000000000", quantity: "100000",
    }));
    const before = await balancesOf(keyB);
    const feeBefore = await feeAccountBalance();

    const r = await placeOrder(testPool(), limitOrder({
      keyId: keyB, market: "BTC-USDT", side: "sell", price: "8000000000", quantity: "100000",
    }));

    expect(r.order.status).toBe("filled");
    expect(r.trades).toHaveLength(1);
    const trade = r.trades[0] as TradeRow;
    expect(trade).toMatchObject({
      price: "8000000000", quantity: "100000", notional: "8000000", buyer_fee: "8000", seller_fee: "8000",
      buy_order_id: rest.order.id, sell_order_id: r.order.id,
    });

    const transferLegs = await withTx(testPool(), (c) => L.getTransfer(c, EXCHANGE_LEDGER_ID, trade.transfer_id));
    expect(transferLegs?.legs).toHaveLength(3);
    const byAmount = (transferLegs?.legs ?? []).map((l) => l.amount).sort();
    expect(byAmount).toEqual(["100000", "16000", "7992000"].sort());

    const restAfter = await orderRow(rest.order.id);
    expect(restAfter?.status).toBe("filled");
    const restHold = await holdOf(rest.order.hold_id);
    expect(restHold).toMatchObject({ status: "captured", remaining: "0" });

    const sellHold = await holdOf(r.order.hold_id);
    expect(sellHold).toMatchObject({ status: "captured", remaining: "0" });

    const buyerAfter = await balancesOf(keyA);
    expect(buyerAfter.USDT!.balance - restBefore.USDT!.balance).toBe(-8_008_000n);
    expect(buyerAfter.USDT!.held).toBe(0n);
    expect(buyerAfter.BTC!.balance - restBefore.BTC!.balance).toBe(100_000n);

    const sellerAfter = await balancesOf(keyB);
    expect(sellerAfter.USDT!.balance - before.USDT!.balance).toBe(7_992_000n);
    expect(sellerAfter.BTC!.balance - before.BTC!.balance).toBe(-100_000n);
    expect(sellerAfter.BTC!.held).toBe(0n);

    expect((await feeAccountBalance()) - feeBefore).toBe(16_000n);
  });

  // Scenario (c). A resting buy for 3 lots (300,000 base units, notional 24,000,000, hold
  // 24,024,000) meets a sell for 1 lot only. The fill draws 8,008,000 from the buyer's
  // hold (as in scenario b), leaving 16,016,000 open on a hold that has not closed, and the
  // order at 100,000 of 300,000 filled: partially_filled.
  it("(c) a partial fill leaves partially_filled with the remaining hold still open", async () => {
    const rest = await placeOrder(testPool(), limitOrder({
      keyId: keyA, market: "BTC-USDT", side: "buy", price: "8000000000", quantity: "300000",
    }));
    expect((await holdOf(rest.order.hold_id)).amount).toBe("24024000");

    const r = await placeOrder(testPool(), limitOrder({
      keyId: keyB, market: "BTC-USDT", side: "sell", price: "8000000000", quantity: "100000",
    }));
    expect(r.order.status).toBe("filled");

    const restAfter = await orderRow(rest.order.id);
    expect(restAfter).toMatchObject({ status: "partially_filled", filled_quantity: "100000" });
    const restHold = await holdOf(rest.order.hold_id);
    expect(restHold).toMatchObject({ status: "open", remaining: "16016000" });
  });

  // Scenario (d). key B's resting buy at (c) leaves 200,000 base units still crossable at
  // 8,000,000,000. A post_only sell at or below that price would immediately take it, so
  // it must be rejected before any hold is created and before the resting order is
  // touched at all.
  it("(d) post_only that would take is rejected before any fill or hold", async () => {
    const before = await balancesOf(keyC);
    const restBefore = await orderRow((await currentRestingBuyId())!);

    const reason = await rejectedDetail(placeOrder(testPool(), limitOrder({
      keyId: keyC, market: "BTC-USDT", side: "sell", price: "8000000000", quantity: "100000", postOnly: true,
    })));
    expect(reason).toBe("post_only_would_take");

    const after = await balancesOf(keyC);
    expect(after).toEqual(before);
    const { rows } = await testPool().query("select count(*)::int as n from holds where account_id in (select id from accounts where ledger_id = $1 and name = $2)", [EXCHANGE_LEDGER_ID, keyC]);
    expect(rows[0]?.n).toBe(0);
    const restAfter = await orderRow(restBefore!.id);
    expect(restAfter).toMatchObject({ status: restBefore!.status, filled_quantity: restBefore!.filled_quantity });
  });

  // Scenario (e). The same resting liquidity (200,000 base units) cannot fill a FOK sell
  // for 300,000: rejected before any write, book unchanged.
  it("(e) FOK that cannot fill in full is rejected with the book unchanged", async () => {
    const restBefore = await orderRow((await currentRestingBuyId())!);

    const reason = await rejectedDetail(placeOrder(testPool(), limitOrder({
      keyId: keyC, market: "BTC-USDT", side: "sell", price: "8000000000", quantity: "300000", timeInForce: "FOK",
    })));
    expect(reason).toBe("fok_not_fillable");

    const restAfter = await orderRow(restBefore!.id);
    expect(restAfter).toMatchObject({ status: restBefore!.status, filled_quantity: restBefore!.filled_quantity });
  });

  // Scenario (f). An IOC sell for 300,000 against the same 200,000 of resting liquidity
  // fills 200,000 (closing the resting buy's hold exactly, as in scenario b) and cancels
  // the remaining 100,000. The seller's hold reserved 300,000 base units and only 200,000
  // were ever drawn from it, so closing it out is capture_close_hold, not release_hold: it
  // already paid for something real, so its terminal status is captured, not released, with
  // the journal recording a hold.captured for it even though 100,000 of it was never spent.
  // notional for 200,000 base units = 16,000,000, fee 16,000 each side.
  it("(f) IOC fills what it can and cancels the remainder, closing its hold as captured", async () => {
    const restId = (await currentRestingBuyId())!;
    const restBefore = await orderRow(restId);

    const before = await balancesOf(keyC);
    const r = await placeOrder(testPool(), limitOrder({
      keyId: keyC, market: "BTC-USDT", side: "sell", price: "8000000000", quantity: "300000", timeInForce: "IOC",
    }));

    expect(r.order).toMatchObject({ status: "cancelled", filled_quantity: "200000" });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({ quantity: "200000", notional: "16000000", buyer_fee: "16000", seller_fee: "16000" });

    const restAfter = await orderRow(restId);
    expect(restAfter?.status).toBe("filled");
    expect((await holdOf(restBefore!.hold_id))).toMatchObject({ status: "captured", remaining: "0" });

    const sellHold = await holdOf(r.order.hold_id);
    expect(sellHold).toMatchObject({ status: "captured", remaining: "0" });
    expect(await journalHasKind(r.order.hold_id!, "hold.captured")).toBe(true);

    const after = await balancesOf(keyC);
    expect(after.BTC!.balance - before.BTC!.balance).toBe(-200_000n);
    expect(after.BTC!.held).toBe(0n);
    await expectHeldMatchesOpenHolds(keyC);
  });

  // Scenario (g). ETH-USDT: tick 10,000 (0.01 USDT), lot 1,000,000 (0.01 ETH), base
  // exponent 8. B rests a sell of 2 lots at 1,000.00 USDT (notional per lot 10,000,000; two
  // lots 20,000,000, fee 20,000). C rests a sell of 3 lots at 1,010.00 USDT (notional per
  // lot 10,100,000, fee 10,100). A market buy with quote_amount 30,130,100 exactly affords
  // B's whole 2 lots (20,000,000 + 20,000 = 20,020,000) and exactly 1 of C's 3 lots
  // (10,100,000 + 10,100 = 10,110,100), leaving C partially filled with 2 lots resting and
  // A's hold drawn to exactly zero.
  it("(g) a market buy fills the largest lot multiple that fits at each of two levels", async () => {
    const b = await placeOrder(testPool(), limitOrder({
      keyId: keyB, market: "ETH-USDT", side: "sell", price: "1000000000", quantity: "2000000",
    }));
    const c = await placeOrder(testPool(), limitOrder({
      keyId: keyC, market: "ETH-USDT", side: "sell", price: "1010000000", quantity: "3000000",
    }));

    const before = await balancesOf(keyA);
    const r = await placeOrder(testPool(), {
      keyId: keyA, market: "ETH-USDT", clientOrderId: null, side: "buy", type: "market", timeInForce: "IOC",
      postOnly: false, price: null, quantity: null, quoteAmount: "30130100",
    });

    expect(r.order).toMatchObject({ status: "filled", filled_quantity: "3000000", filled_quote: "30100000" });
    expect(r.trades).toHaveLength(2);
    expect(r.trades[0]).toMatchObject({ quantity: "2000000", notional: "20000000", buyer_fee: "20000" });
    expect(r.trades[1]).toMatchObject({ quantity: "1000000", notional: "10100000", buyer_fee: "10100" });

    const bAfter = await orderRow(b.order.id);
    expect(bAfter).toMatchObject({ status: "filled", filled_quantity: "2000000" });
    const cAfter = await orderRow(c.order.id);
    expect(cAfter).toMatchObject({ status: "partially_filled", filled_quantity: "1000000" });
    const cHold = await holdOf(c.order.hold_id);
    expect(cHold).toMatchObject({ status: "open", remaining: "2000000" });

    const buyHold = await holdOf(r.order.hold_id);
    expect(buyHold).toMatchObject({ status: "captured", remaining: "0" });

    const after = await balancesOf(keyA);
    expect(after.ETH!.balance - before.ETH!.balance).toBe(3_000_000n);
    expect(after.USDT!.balance - before.USDT!.balance).toBe(-30_130_100n);
    expect(after.USDT!.held).toBe(before.USDT!.held);
  });

  // Scenario (h): the six remaining named rejections, each isolated to exactly one cause.
  it("(h) price not a tick multiple", async () => {
    const reason = await rejectedDetail(placeOrder(testPool(), limitOrder({
      keyId: keyA, market: "BTC-USDT", side: "buy", price: "8000000001", quantity: "100000", clientOrderId: newId("evt"),
    })));
    expect(reason).toBe("price_not_tick");
  });

  it("(h) quantity not a lot multiple", async () => {
    const reason = await rejectedDetail(placeOrder(testPool(), limitOrder({
      keyId: keyA, market: "BTC-USDT", side: "buy", price: "8000000000", quantity: "150000", clientOrderId: newId("evt"),
    })));
    expect(reason).toBe("quantity_not_lot");
  });

  it("(h) below the market's minimum notional", async () => {
    const reason = await rejectedDetail(placeOrder(testPool(), limitOrder({
      keyId: keyA, market: "BTC-USDT", side: "buy", price: "10000", quantity: "100000", clientOrderId: newId("evt"),
    })));
    expect(reason).toBe("below_min_notional");
  });

  it("(h) a halted market", async () => {
    await testPool().query("update markets set status = 'halted' where symbol = 'ETH-USDT'");
    try {
      const reason = await rejectedDetail(placeOrder(testPool(), limitOrder({
        keyId: keyA, market: "ETH-USDT", side: "buy", price: "1000000000", quantity: "1000000", clientOrderId: newId("evt"),
      })));
      expect(reason).toBe("market_halted");

      const { rows } = await testPool().query<{ type: string; payload: { reason: string } }>(
        "select type, payload from market_events where market = 'ETH-USDT' and type = 'order.rejected' order by seq desc limit 1");
      expect(rows[0]?.payload.reason).toBe("market_halted");
      const { rows: keyEvents } = await testPool().query<{ type: string }>(
        "select type from events where key_id = $1 and type = 'order.rejected' order by created_at desc limit 1", [keyA]);
      expect(keyEvents[0]?.type).toBe("order.rejected");
    } finally {
      await testPool().query("update markets set status = 'open' where symbol = 'ETH-USDT'");
    }
  });

  it("(h) a duplicate client_order_id", async () => {
    const clientOrderId = "dup-" + newId("evt");
    const first = await placeOrder(testPool(), limitOrder({
      keyId: keyA, market: "BTC-USDT", side: "buy", price: "7000000000", quantity: "100000", clientOrderId,
    }));
    try {
      const reason = await rejectedDetail(placeOrder(testPool(), limitOrder({
        keyId: keyA, market: "BTC-USDT", side: "buy", price: "7000000000", quantity: "100000", clientOrderId,
      })));
      expect(reason).toBe("duplicate_client_order_id");
    } finally {
      await withTx(testPool(), (c) => cancelOrder(c, keyA, first.order.id));
    }
  });

  // Review round 1, finding 1: record_rejection (0015_rejected_orders.sql) inserts the
  // order row itself now, status rejected, with the caller's own client_order_id, price and
  // quantity; no hold was ever created here (the hold attempt is what raised
  // insufficient_funds), so hold_id and accepted_seq stay null.
  it("(h) insufficient funds on an unfunded key", async () => {
    const keyD = await sandboxKey();
    const clientOrderId = newId("evt");
    const reason = await rejectedDetail(placeOrder(testPool(), limitOrder({
      keyId: keyD, market: "BTC-USDT", side: "buy", price: "8000000000", quantity: "100000", clientOrderId,
    })));
    expect(reason).toBe("insufficient_funds");

    const { rows } = await testPool().query<{ status: string; reject_reason: string; hold_id: string | null; accepted_seq: string | null; price: string; quantity: string }>(
      "select status, reject_reason, hold_id, accepted_seq, price::text as price, quantity::text as quantity from orders where client_order_id = $1 and key_id = $2",
      [clientOrderId, keyD]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "rejected", reject_reason: "insufficient_funds", hold_id: null, accepted_seq: null,
      price: "8000000000", quantity: "100000",
    });
  });

  // Task 6 amendment (0016_house_ladder.sql): notional_too_large, the tenth named reason,
  // found building the house ladder. Ten BTC at 9,300.00 USDT each is an entirely
  // reasonable order on its own, but price times quantity, 9,300,000,000 times
  // 1,000,000,000, is 9.3 * 10^18, over bigint's 9,223,372,036,854,775,807 maximum, even
  // though the notional it actually represents, 93,000,000,000 (93,000.00 USDT), is
  // nowhere near that on its own: (p_price * p_quantity) / v_divisor used to overflow
  // computing the numerator alone, before the divide ever ran, crashing as a raw "bigint
  // out of range" database error instead of accepting an order this ordinary. Fee (10 bps)
  // is a plain ceil(93,000,000,000 * 10 / 10000) = 93,000,000, hold 93,093,000,000.
  it("(h) accepts an order whose price times quantity overflows bigint before the divide, when the notional itself does not", async () => {
    const keyH = await fundedKey();
    const placed = await placeOrder(testPool(), limitOrder({
      keyId: keyH, market: "BTC-USDT", side: "buy", price: "9300000000", quantity: "1000000000", clientOrderId: newId("evt"),
    }));
    expect(placed.order.status).toBe("open");
    const hold = await holdOf(placed.order.hold_id);
    expect(hold).toMatchObject({ status: "open", amount: "93093000000" });
    await withTx(testPool(), (c) => cancelOrder(c, keyH, placed.order.id));
  });

  // Review round 1, finding 1: self_trade, the ninth named reason. A key's own resting
  // order is still just an order sitting on the book; without this check the walk would
  // build a post_transfer leg moving money from that key's own account to itself, and
  // post_transfer already refuses that outright as validation_failed, the wrong answer for
  // what is really this order's own problem. Checked unconditionally, for every order type
  // and every time in force, not only post_only and FOK.
  it("self_trade rejects a key crossing its own resting order, leaving the book and its holds untouched", async () => {
    const keyE = await fundedKey();
    const resting = await placeOrder(testPool(), limitOrder({
      keyId: keyE, market: "BTC-USDT", side: "sell", price: "9000000000", quantity: "100000",
    }));
    const holdsBefore = await holdsCountFor(keyE);

    const reason = await rejectedDetail(placeOrder(testPool(), limitOrder({
      keyId: keyE, market: "BTC-USDT", side: "buy", price: "9000000000", quantity: "100000", clientOrderId: newId("evt"),
    })));
    expect(reason).toBe("self_trade");

    const restingAfter = await orderRow(resting.order.id);
    expect(restingAfter).toMatchObject({ status: "open", filled_quantity: "0" });
    expect(await holdsCountFor(keyE)).toBe(holdsBefore);

    await withTx(testPool(), (c) => cancelOrder(c, keyE, resting.order.id));
  });

  // Review round 1, finding 2 ("Trace B"): a limit buy holds notional plus fee at its own
  // price, 81,000.00 USDT, but the resting sell it crosses is priced better, 80,000.00
  // USDT, and every fill happens at the resting price. price 80,000.00 USDT =
  // 80,000,000,000, quantity 0.001 BTC = 100,000: notional 80,000,000, and since this is
  // the first and only fill for both fresh orders, fee (10 bps) is a plain
  // ceil(80,000,000 * 10 / 10000) = 80,000 each side. The buyer's own notional at 81,000.00
  // USDT is 81,000,000,000 * 100,000 / 10^8 = 81,000,000, taker fee ceil(81,000,000 * 10 /
  // 10000) = 81,000, hold 81,081,000. Drawn 80,000,000 + 80,000 = 80,080,000, leaving
  // 1,001,000 on a hold that already paid for something real: closing it is
  // capture_close_hold, terminal status captured, not release_hold.
  it("Trace B: a limit buy filling at a better price than its own closes the leftover as captured, not released", async () => {
    const keyF = await fundedKey();
    const keyG = await fundedKey();
    const resting = await placeOrder(testPool(), limitOrder({
      keyId: keyF, market: "BTC-USDT", side: "sell", price: "80000000000", quantity: "100000",
    }));
    const r = await placeOrder(testPool(), limitOrder({
      keyId: keyG, market: "BTC-USDT", side: "buy", price: "81000000000", quantity: "100000",
    }));

    expect(r.order).toMatchObject({ status: "filled", filled_quantity: "100000" });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({
      price: "80000000000", quantity: "100000", notional: "80000000", buyer_fee: "80000", seller_fee: "80000",
    });

    const buyHold = await holdOf(r.order.hold_id);
    expect(buyHold).toMatchObject({ status: "captured", remaining: "0", amount: "81081000" });
    expect(await journalHasKind(r.order.hold_id!, "hold.captured")).toBe(true);
    await expectHeldMatchesOpenHolds(keyG);

    const sellAfter = await orderRow(resting.order.id);
    expect(sellAfter?.status).toBe("filled");
    expect((await holdOf(resting.order.hold_id))).toMatchObject({ status: "captured", remaining: "0" });
  });

  // Review round 1, finding 3: price 8,012,340,000 (a tick multiple) gives a per lot
  // notional of 8,012,340, not a multiple of 1,000, so ceil(notional * 10 / 10000) does not
  // distribute evenly across three equal fills. The naive way, ceil applied to each fill's
  // own notional in isolation, gives 8,013 three times, summing to 24,039, one more than
  // the hold's own single ceiling: ceil(24,037,020 * 10 / 10000) = 24,038 for the full
  // 300,000 quantity (3 lots), reserved as part of a hold of 24,061,058. The fix's
  // telescoping fee, the increment of the ceiling on the order's cumulative filled quote,
  // sums to exactly 24,038 regardless of how unevenly it lands on each of the three fills.
  it("fee rounding across three separate fills sums to exactly the hold's reserved fee, not more", async () => {
    const keyBuyer = await fundedKey();
    const seller1 = await fundedKey();
    const seller2 = await fundedKey();
    const seller3 = await fundedKey();

    const resting = await placeOrder(testPool(), limitOrder({
      keyId: keyBuyer, market: "BTC-USDT", side: "buy", price: "8012340000", quantity: "300000",
    }));
    expect((await holdOf(resting.order.hold_id)).amount).toBe("24061058");

    for (const seller of [seller1, seller2, seller3]) {
      await placeOrder(testPool(), limitOrder({
        keyId: seller, market: "BTC-USDT", side: "sell", price: "8012340000", quantity: "100000",
      }));
    }

    const { rows } = await testPool().query<{ buyer_fee: string }>(
      "select buyer_fee::text as buyer_fee from trades where buy_order_id = $1 order by seq", [resting.order.id]);
    expect(rows).toHaveLength(3);
    const fees = rows.map((row) => BigInt(row.buyer_fee));
    expect(fees.reduce((a, b) => a + b, 0n)).toBe(24_038n);
    // The naive per fill ceil would give 8,013 every time (24,039 total); at least one of
    // the three telescoping fees must differ from that constant for the sum to land on
    // 24,038 instead.
    expect(fees.some((f) => f !== 8_013n)).toBe(true);

    const restAfter = await orderRow(resting.order.id);
    expect(restAfter).toMatchObject({ status: "filled", filled_quantity: "300000", filled_quote: "24037020" });
    expect((await holdOf(resting.order.hold_id))).toMatchObject({ status: "captured", remaining: "0" });
  });

  // Review round 1, finding 4 (minor): the application level duplicate check and the
  // orders_client_order_idx unique index can disagree only across a race two different
  // markets' advisory locks do not serialise against each other: two place_order calls for
  // the same key and client_order_id on two different markets can both pass the exists
  // check before either commits, and whichever commits second hits the raw index instead.
  // Inserting a second orders row by hand reproduces that exact Postgres error without
  // needing real concurrency.
  it("maps a raw duplicate client_order_id constraint violation to order_rejected", async () => {
    const keyH = await fundedKey();
    const clientOrderId = "race-" + newId("evt");
    const first = await placeOrder(testPool(), limitOrder({
      keyId: keyH, market: "BTC-USDT", side: "buy", price: "7500000000", quantity: "100000", clientOrderId,
    }));
    try {
      const err = await testPool().query(
        `insert into orders (id, key_id, market, client_order_id, side, type, time_in_force, post_only,
           price, quantity, quote_amount, filled_quantity, filled_quote, status, hold_id, accepted_seq,
           reject_reason, created_at, updated_at)
         values ($1, $2, 'ETH-USDT', $3, 'buy', 'limit', 'GTC', false, 100000000, 1000000, null, 0, 0,
           'open', null, null, null, now(), now())`,
        [newId("ord"), keyH, clientOrderId],
      ).catch((e: unknown) => e);
      expect(mapDbError(err)?.code).toBe("order_rejected");
      expect(mapDbError(err)?.message).toBe("duplicate_client_order_id");
    } finally {
      await withTx(testPool(), (c) => cancelOrder(c, keyH, first.order.id));
    }
  });

  it("cancels a resting order, releasing its hold, and is idempotent on a second cancel", async () => {
    const before = await balancesOf(keyA);
    const r = await placeOrder(testPool(), limitOrder({
      keyId: keyA, market: "BTC-USDT", side: "buy", price: "8000000000", quantity: "100000",
    }));
    const held = (await balancesOf(keyA)).USDT!.held - before.USDT!.held;
    expect(held).toBeGreaterThan(0n);

    const cancelled = await withTx(testPool(), (c) => cancelOrder(c, keyA, r.order.id));
    expect(cancelled.order.status).toBe("cancelled");
    expect((await holdOf(r.order.hold_id))).toMatchObject({ status: "released", remaining: "0" });
    const after = await balancesOf(keyA);
    expect(after.USDT!.held).toBe(before.USDT!.held);
    expect(after.USDT!.balance).toBe(before.USDT!.balance);

    const again = await withTx(testPool(), (c) => cancelOrder(c, keyA, r.order.id));
    expect(again.order.status).toBe("cancelled");
    expect(again.event_ids).toEqual([]);
  });

  it("refuses to cancel an order that does not belong to the caller, or does not exist", async () => {
    const r = await placeOrder(testPool(), limitOrder({
      keyId: keyA, market: "BTC-USDT", side: "buy", price: "8000000000", quantity: "100000",
    }));
    try {
      const err = await withTx(testPool(), (c) => cancelOrder(c, keyB, r.order.id)).catch((e: unknown) => e);
      expect(mapDbError(err)?.code).toBe("not_found");
      const missing = await withTx(testPool(), (c) => cancelOrder(c, keyA, newId("ord"))).catch((e: unknown) => e);
      expect(mapDbError(missing)?.code).toBe("not_found");
    } finally {
      await withTx(testPool(), (c) => cancelOrder(c, keyA, r.order.id));
    }
  });

  // Helper for the scenarios (d), (e) and (f) that share the resting buy left open by (c):
  // the single open BTC-USDT buy belonging to keyA.
  async function currentRestingBuyId(): Promise<string | null> {
    const { rows } = await testPool().query<{ id: string }>(
      "select id from orders where market = 'BTC-USDT' and side = 'buy' and key_id = $1 and status = 'partially_filled' order by created_at desc limit 1",
      [keyA]);
    return rows[0]?.id ?? null;
  }
});
