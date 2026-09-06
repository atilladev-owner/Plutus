import { z } from "zod";
import { Receiver } from "@upstash/qstash";
import { defineRoute } from "../platform/route.js";
import { ApiError } from "../domain/errors.js";
import { deliverOnce } from "../platform/deliver.js";
import { safeEqual } from "../platform/auth.js";
import type { AppDeps } from "../deps.js";
import { withTx } from "../db/pool.js";
import * as L from "../db/ledger.js";
import * as W from "../db/webhooks.js";
import * as X from "../db/exchange.js";
import { purgeOld } from "../db/events.js";
import { purgeExpired } from "../db/idempotency.js";
import { newId } from "../domain/ids.js";
import { ensureFreshLadder } from "./exchange-house.js";

const SweepOut = z.object({
  expired_holds: z.number().int(),
  deleted_ledgers: z.number().int(),
  deleted_keys: z.number().int(),
  deleted_events: z.number().int(),
  deleted_idempotency: z.number().int(),
  republished_deliveries: z.number().int(),
  markets_refreshed: z.number().int(),
  house_topups: z.number().int(),
});

const HOUSE_STALE_MS = 15_000;

/** The house's seed, spec 10.2: 10,000 BTC, 100,000 ETH, 1,000,000,000 USDT, all in minor
 * units. Keyed by the exact account name migration 0011 gave each of the house's three
 * inventory accounts (never key_house, see 0016_house_ladder.sql's own note on that), so a
 * plain lookup on the row's own name decides whether it is one of these three at all. */
const HOUSE_SEED: Record<string, bigint> = {
  BTC: 1_000_000_000_000n,
  ETH: 10_000_000_000_000n,
  USDT: 1_000_000_000_000_000n,
};

/** Refreshes every market whose house ladder is stale, spec 10.5's own "the daily sweep
 * refreshes cold markets too". ensureFreshLadder re-checks staleness itself under the
 * market lock, so this only needs to decide which markets are worth calling it for and
 * count how many were.
 *
 * Review finding: one market's own refresh failing, for any reason, used to abort this
 * whole loop and, since sweep below runs topUpHouse right after it with nothing to catch
 * an escaped exception, the house top up too, on a day the sweep had the most reason to
 * run both. Each market's refresh is wrapped in its own try/catch instead: a failure is
 * logged (so it is visible, not silent) and counted as not refreshed, but every other
 * market this call finds stale still gets its own attempt, and the caller always gets a
 * count back rather than an exception. refresh defaults to the real ensureFreshLadder;
 * tests/integration/sweep.test.ts passes its own, to make one market fail on demand
 * without touching a real network or the shared BTC-USDT and ETH-USDT books other
 * exchange test files trade on. */
export async function refreshColdMarkets(
  deps: AppDeps,
  refresh: (deps: AppDeps, market: string) => Promise<void> = ensureFreshLadder,
  candidates?: string[],
): Promise<number> {
  // candidates lets a test name the markets to walk without touching the shared markets table.
  const markets = candidates ? candidates.map((symbol) => ({ symbol, house_quoted_at: null })) : await withTx(deps.pool, (c) => X.listMarkets(c));
  const now = Date.now();
  let refreshed = 0;
  for (const m of markets) {
    if (m.house_quoted_at !== null && now - m.house_quoted_at.getTime() < HOUSE_STALE_MS) continue;
    try {
      await refresh(deps, m.symbol);
      refreshed++;
    } catch (err) {
      deps.logger.error({ market: m.symbol, err: (err as Error).message }, "house ladder refresh failed; the next sweep tries again");
    }
  }
  return refreshed;
}

/** Tops up any house inventory account below a quarter of its seed, back up to the full
 * seed, from the world (spec 10.2). Conservation holds because the world goes negative by
 * exactly the amount transferred in, the same as the house's original seed funding
 * (0011_exchange.sql). Runs unconditionally after refreshColdMarkets, win or lose: the two
 * share nothing but deps, so a market's own refresh failing never has anything to do with
 * whether the house's own balances get topped up. */
export async function topUpHouse(deps: AppDeps): Promise<number> {
  return withTx(deps.pool, async (c) => {
    const { rows } = await c.query<{ id: string; asset: string; balance: string }>(
      "select id, asset, balance::text as balance from accounts where ledger_id = $1 and kind = 'normal' and name = any($2::text[])",
      [X.EXCHANGE_LEDGER_ID, Object.keys(HOUSE_SEED)]);
    let topups = 0;
    for (const row of rows) {
      const seed = HOUSE_SEED[row.asset];
      if (seed === undefined) continue;
      const balance = BigInt(row.balance);
      if (balance >= seed / 4n) continue;
      await L.postTransfer(c, {
        ledgerId: X.EXCHANGE_LEDGER_ID, transferId: newId("tr"),
        legs: [{ from: `world:${row.asset}`, to: row.id, asset: row.asset, amount: (seed - balance).toString() }],
        memo: "house top up", metadata: {},
      });
      topups++;
    }
    return topups;
  });
}

/**
 * Daily housekeeping, in three transactions. The first expires holds whose time is up and
 * commits on its own. The second deletes idle sandbox ledgers and keys, alone: a ledger
 * delete cascades to its accounts, transfers, legs, holds and journal rows, so against a
 * large enough idle backlog it can run long enough on its own to hit the pool's 25 second
 * statement timeout, and this way that timeout costs only this purge, not the event purge,
 * the idempotency purge or the stale delivery republish. The third purges old events and
 * expired idempotency records (each capped, see SWEEP_DELETE_CAP in the respective db
 * module), and republishes any delivery left pending past its due time (stalePending, in
 * src/db/webhooks.ts): one QStash message lost never costs a delivery, only a delay.
 * Guarded by CRON_SECRET compared in constant time; a missing secret refuses every call
 * rather than accepting one.
 */
async function sweep({ deps, req }: { deps: AppDeps; req: import("express").Request }) {
  const secret = deps.config.CRON_SECRET;
  const header = req.header("authorization") ?? "";
  if (!secret || !safeEqual(header, `Bearer ${secret}`)) throw new ApiError(401, "unauthorized", "internal route");
  // Hold expiry commits in its own transaction before any purge runs. Each purge below is
  // capped, but a large enough uncapped backlog elsewhere, or a slow plan, can still hit
  // the pool's 25 second statement timeout; if that happened inside the same transaction
  // as the hold expiry loop, the failure would roll back holds that had already, correctly,
  // expired, and the next run would face the same backlog and fail the same way.
  const expiredHolds = await withTx(deps.pool, async (c) => {
    let n = 0;
    for (const id of await L.ledgersWithExpiredHolds(c)) n += await L.expireHolds(c, id, null);
    return n;
  });
  const idle = await withTx(deps.pool, (c) => L.deleteIdleSandbox(c));
  const out = await withTx(deps.pool, async (c) => {
    const events = await purgeOld(c);
    const idem = await purgeExpired(c);
    const stale = await W.stalePending(c, 60);
    return { deleted_events: events, deleted_idempotency: idem, stale };
  });
  for (const id of out.stale) await deps.scheduler.schedule(id, 0);
  const { stale, ...rest } = out;
  const marketsRefreshed = await refreshColdMarkets(deps);
  const houseTopups = await topUpHouse(deps);
  return {
    expired_holds: expiredHolds, deleted_ledgers: idle.ledgers, deleted_keys: idle.keys, ...rest,
    republished_deliveries: stale.length, markets_refreshed: marketsRefreshed, house_topups: houseTopups,
  };
}

export const internalRoutes = [
  defineRoute({ method: "get", path: "/internal/sweep", summary: "Daily housekeeping", tag: "Internal", auth: "none", limit: "none", response: SweepOut, handler: sweep }),
  defineRoute({ method: "post", path: "/internal/sweep", summary: "Daily housekeeping", tag: "Internal", auth: "none", limit: "none", response: SweepOut, handler: sweep }),
  defineRoute({
    method: "post", path: "/internal/webhooks/deliver", summary: "QStash callback that makes one delivery attempt", tag: "Internal", auth: "none", limit: "none",
    body: z.object({ delivery_id: z.string().regex(/^whd_[0-9a-f]{32}$/) }), response: z.object({ ok: z.boolean() }),
    handler: async ({ deps, body, req }) => {
      const { QSTASH_CURRENT_SIGNING_KEY: cur, QSTASH_NEXT_SIGNING_KEY: nxt, CRON_SECRET } = deps.config;
      const internal = req.header("x-plutus-internal") ?? "";
      if (cur && nxt) {
        const sig = req.header("upstash-signature") ?? "";
        // Verify against the exact bytes the body was sent as (req.rawBody, captured by
        // express.json's verify option), not JSON.stringify(req.body): re-serialising is
        // not guaranteed to match byte for byte what QStash actually signed.
        const ok = await new Receiver({ currentSigningKey: cur, nextSigningKey: nxt }).verify({ signature: sig, body: req.rawBody?.toString("utf8") ?? "", url: `${deps.config.PUBLIC_BASE_URL}/internal/webhooks/deliver` }).catch(() => false);
        if (!ok) throw new ApiError(401, "invalid_signature", "QStash signature did not verify");
      } else if (!CRON_SECRET || !safeEqual(internal, CRON_SECRET)) {
        throw new ApiError(401, "unauthorized", "internal route");
      }
      await deliverOnce(deps, body.delivery_id);
      return { ok: true };
    },
  }),
];
