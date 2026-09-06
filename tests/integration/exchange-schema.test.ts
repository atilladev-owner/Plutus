import { describe, it, expect } from "vitest";
import { testPool } from "../helpers/db.js";
import { verifyExchangeLedger } from "../helpers/exchange.js";
import { withTx } from "../../src/db/pool.js";
import { mapDbError } from "../../src/db/errors.js";
import { EXCHANGE_LEDGER_ID, HOUSE_KEY_ID, MARKETS, listMarkets } from "../../src/db/exchange.js";

interface AccountRow { id: string; asset: string; name: string; kind: string; balance: string; held: string }

async function exchangeAccounts(): Promise<AccountRow[]> {
  const { rows } = await testPool().query<AccountRow>(
    "select id, asset, name, kind, balance::text, held::text from accounts where ledger_id = $1 order by asset, name",
    [EXCHANGE_LEDGER_ID]);
  return rows;
}

describe("exchange schema", () => {
  it("seeds the two markets with the exact tick, lot and min notional values from the spec", async () => {
    const rows = await withTx(testPool(), (c) => listMarkets(c));
    expect(rows.map((r) => r.symbol)).toEqual([...MARKETS]);
    const btc = rows.find((r) => r.symbol === "BTC-USDT");
    expect(btc).toMatchObject({
      base: "BTC", quote: "USDT", tick_size: "10000", lot_size: "100000", min_notional: "5000000",
      maker_fee_bps: 10, taker_fee_bps: 10, status: "open",
    });
    const eth = rows.find((r) => r.symbol === "ETH-USDT");
    expect(eth).toMatchObject({
      base: "ETH", quote: "USDT", tick_size: "10000", lot_size: "1000000", min_notional: "5000000",
      maker_fee_bps: 10, taker_fee_bps: 10, status: "open",
    });
  });

  it("rejects a tick and lot for BTC whose product is not a multiple of ten to the base exponent", async () => {
    const err = await testPool().query(
      "insert into markets (symbol, base, quote, tick_size, lot_size, min_notional, maker_fee_bps, taker_fee_bps, status) values ('BTC-BAD', 'BTC', 'USDT', 3, 7, 1, 10, 10, 'open')",
    ).catch((e: unknown) => e);
    expect(mapDbError(err)?.code).toBe("validation_failed");
    const { rows } = await testPool().query("select 1 from markets where symbol = 'BTC-BAD'");
    expect(rows).toHaveLength(0);
  });

  it("gives the exchange ledger to a live mode house key exempt from the sandbox rules", async () => {
    const { rows: ledgerRows } = await testPool().query<{ key_id: string }>("select key_id from ledgers where id = $1", [EXCHANGE_LEDGER_ID]);
    expect(ledgerRows[0]?.key_id).toBe(HOUSE_KEY_ID);
    const { rows: keyRows } = await testPool().query<{ mode: string }>("select mode from api_keys where id = $1", [HOUSE_KEY_ID]);
    expect(keyRows[0]?.mode).toBe("live");
    const { rows: sandboxRows } = await testPool().query<{ sandbox: boolean }>("select ledger_is_sandbox($1) as sandbox", [EXCHANGE_LEDGER_ID]);
    expect(sandboxRows[0]?.sandbox).toBe(false);
  });

  it("funds the house with positive balances seeded at migration, and gives it a USDT fee account", async () => {
    const accounts = await exchangeAccounts();
    const btc = accounts.find((a) => a.kind === "normal" && a.asset === "BTC");
    const eth = accounts.find((a) => a.kind === "normal" && a.asset === "ETH");
    const usdt = accounts.find((a) => a.kind === "normal" && a.asset === "USDT" && a.name === "USDT");
    const fee = accounts.find((a) => a.name === "fee:USDT");
    // Not asserted as exactly the seed (10,000 BTC, 100,000 ETH, 1,000,000,000 USDT, from
    // this same migration): from task 6 onward the house actually trades, and the fee
    // account is never the only one that moves. A fresh seed, and every fill or top up
    // since, only guarantees each stays positive, not that nothing has traded yet.
    expect(BigInt(btc?.balance ?? "-1")).toBeGreaterThan(0n);
    expect(BigInt(eth?.balance ?? "-1")).toBeGreaterThan(0n);
    expect(BigInt(usdt?.balance ?? "-1")).toBeGreaterThan(0n);
    expect(fee).toMatchObject({ asset: "USDT", kind: "normal" });
    expect(BigInt(fee?.balance ?? "-1")).toBeGreaterThanOrEqual(0n);
  });

  it("balances the world against the house on the fresh ledger, and verify reports ok", async () => {
    const accounts = await exchangeAccounts();
    const world = new Map(accounts.filter((a) => a.kind === "world").map((a) => [a.asset, a]));
    const houseSum = new Map<string, bigint>();
    for (const a of accounts) {
      if (a.kind !== "normal") continue;
      houseSum.set(a.asset, (houseSum.get(a.asset) ?? 0n) + BigInt(a.balance));
    }
    for (const [asset, sum] of houseSum) {
      expect(BigInt(world.get(asset)?.balance ?? "0")).toBe(-sum);
    }

    const report = await verifyExchangeLedger();
    expect(report).toMatchObject({ ok: true, chain_ok: true, sequence_ok: true, replay_matches: true });
    expect(report.assets.every((a) => a.sum === "0")).toBe(true);
  });
});
