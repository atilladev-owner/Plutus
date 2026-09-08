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
import * as K from "../db/keys.js";
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
  deleted_orders: z.number().int(),
  deleted_market_events: z.number().int(),
  deleted_old_secrets: z.number().int(),
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
 * Runs one capped delete as a statement of its own on the pool, logging and answering zero
 * rather than throwing.
 *
 * Review round 1, finding 1: the retention purges used to run inside the same transaction as
 * the event purge, the idempotency purge and the stale delivery republish, with no catch of
 * their own. One of them hitting the pool's 25 second statement timeout therefore rolled
 * back every other purge in that transaction, and, since the throw escaped sweep() entirely,
 * skipped the house ladder refresh and the house top up as well, on the day the sweep had
 * the most reason to run both. None of them needs a transaction at all: one capped delete is
 * atomic by itself. Each failure now costs only its own statement, which is the discipline
 * the idle sandbox purge above already applies.
 */
async function purgeCapped(deps: AppDeps, table: string, run: () => Promise<number>): Promise<number> {
  try {
    return await run();
  } catch (err) {
    deps.logger.error({ table, err: (err as Error).message }, "retention purge failed; the next sweep tries again");
    return 0;
  }
}

/** The most batches one sweep runs against one table, and the wall clock the whole retention
 * run gets, whichever comes first. Review round 1, finding 2: one capped delete a day is
 * below the rate the house ladder writes rows. A refresh cancels ten orders and places ten
 * more per market, and writes a market event for each, whenever an unauthenticated book read
 * finds that market's ladder older than fifteen seconds, which at one read per market per
 * fifteen seconds is about 115,000 orders and 230,000 market events a day against 5,000
 * deleted. Sixty batches is 300,000 rows per table per sweep, above that worst day; the 40
 * second budget is what keeps the sweep itself bounded, since every batch is a statement of
 * its own and a run that has to stop simply leaves the rest for tomorrow. */
const DRAIN_MAX_BATCHES = 60;
const DRAIN_BUDGET_MS = 40_000;

/**
 * Repeats a capped delete until one call comes back short, which is the proof nothing older
 * than the bound is left, or until the batch count or the shared deadline stops it. Each
 * batch is one autocommitted statement through purgeCapped above, so a timeout costs one
 * batch and the count of everything already deleted is still returned and reported.
 */
async function drain(deps: AppDeps, table: string, run: () => Promise<number>, deadline: number): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < DRAIN_MAX_BATCHES; batch++) {
    if (performance.now() >= deadline) {
      deps.logger.warn({ table, deleted: total }, "retention drain out of time; the next sweep continues");
      break;
    }
    const deleted = await purgeCapped(deps, table, run);
    total += deleted;
    // A short batch means the backlog is gone. A failed batch answers zero through
    // purgeCapped, which reads as short here and stops this table for the same reason: there
    // is no point running the same statement 59 more times against whatever just refused it.
    if (deleted < X.SWEEP_DELETE_CAP) break;
  }
  return total;
}

/**
 * Daily housekeeping, in three transactions and then a run of capped deletes that share
 * none. The first transaction expires holds whose time is up and commits on its own. The
 * second deletes idle sandbox ledgers and keys, alone: a ledger delete cascades to its
 * accounts, transfers, legs, holds and journal rows, so against a large enough idle backlog
 * it can run long enough on its own to hit the pool's 25 second statement timeout, and this
 * way that timeout costs only this purge, not the event purge, the idempotency purge or the
 * stale delivery republish. The third purges old events and expired idempotency records
 * (each capped, see SWEEP_DELETE_CAP in the respective db module) and republishes any
 * delivery left pending past its due time (stalePending, in src/db/webhooks.ts): one QStash
 * message lost never costs a delivery, only a delay. The retention purges follow, each a
 * capped delete of its own through purgeCapped above, so none of them can roll back or skip
 * anything else the sweep does. Guarded by CRON_SECRET compared in constant time; a missing
 * secret refuses every call rather than accepting one.
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
  // Whole branch review, finding 1: a trader's fill can leave orders.key_id's cascade
  // reaching a trade this transaction has no other way to touch, and used to fail the
  // delete outright (0017_trades_survive_key_deletion.sql fixes the schema side of that).
  // This try/catch is the other half: whatever still goes wrong deleting idle sandbox data
  // is logged and never allowed to end the sweep early, the same discipline
  // refreshColdMarkets already applies to one market's own ladder refresh failing. Every
  // purge after this one, the house ladder refresh and the top up, still runs; the caller
  // sees zero for both counts on a failure, an honest answer since nothing was deleted, and
  // the next sweep tries again against whatever backlog is still there.
  const idle = await withTx(deps.pool, (c) => L.deleteIdleSandbox(c)).catch((err: unknown) => {
    deps.logger.error({ err: (err as Error).message }, "idle sandbox purge failed; the next sweep tries again");
    return { ledgers: 0, keys: 0 };
  });
  const out = await withTx(deps.pool, async (c) => {
    const events = await purgeOld(c);
    const idem = await purgeExpired(c);
    const stale = await W.stalePending(c, 60);
    return { deleted_events: events, deleted_idempotency: idem, stale };
  });
  for (const id of out.stale) await deps.scheduler.schedule(id, 0);
  const { stale, ...rest } = out;
  // Security sweep, finding 1: the house ladder's own orders and the market events every
  // refresh writes were the two exchange tables nothing ever removed, and an unauthenticated
  // book read is all it takes to grow both (see purgeHouseOrders in src/db/exchange.ts).
  // Finding 5: rotation writes a retiring secret per call and nothing ever removed one, long
  // after any of them could still authenticate. Each runs on the pool, alone. The two the
  // ladder feeds are drained rather than capped once a day, against one deadline shared by
  // both so the sweep as a whole stays bounded; the retiring secrets are written by rotation
  // alone, which no unauthenticated traffic drives, so one capped delete a day stays ahead of
  // them.
  const deadline = performance.now() + DRAIN_BUDGET_MS;
  const deletedOrders = await drain(deps, "orders", () => X.purgeHouseOrders(deps.pool), deadline);
  const deletedMarketEvents = await drain(deps, "market_events", () => X.purgeMarketEvents(deps.pool), deadline);
  const deletedOldSecrets = await purgeCapped(deps, "api_key_old_secrets", () => K.purgeExpiredOldSecrets(deps.pool));
  const marketsRefreshed = await refreshColdMarkets(deps);
  const houseTopups = await topUpHouse(deps);
  return {
    expired_holds: expiredHolds, deleted_ledgers: idle.ledgers, deleted_keys: idle.keys, ...rest,
    deleted_orders: deletedOrders, deleted_market_events: deletedMarketEvents, deleted_old_secrets: deletedOldSecrets,
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
