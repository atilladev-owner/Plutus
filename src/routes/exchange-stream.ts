import type { Express, Request, Response } from "express";
import type { Pool } from "pg";
import { ApiError, validation } from "../domain/errors.js";
import { MARKETS } from "../db/exchange.js";
import { limitWithTimeout, applyRateLimitHeaders } from "../platform/ratelimit.js";
import type { AppDeps } from "../deps.js";

/**
 * The public market event stream, spec 10.7. The spec section is headed "WebSocket", but its
 * own opening line is a ruling: the milestone two plan's spike found no WebSocket upgrade
 * reaches an Express app deployed as a Vercel Function on this account, so the stream ships
 * as Server-Sent Events, with the identical message and sequence contract spec 10.7 itself
 * describes, rather than the socket it opens with. Mounted directly from src/create-app.ts,
 * the way src/routes/docs.ts mounts Scalar and src/routes/landing.ts mounts the page: this
 * route streams, so it never goes through the JSON route registry's response handling
 * (src/platform/route.ts's mountRoutes), and it carries no defineRoute entry of its own. The
 * hand written OpenAPI path item below (streamOpenApiPath) is what src/routes/docs.ts merges
 * into the generated document in its place.
 *
 * Every message is derived straight from a market_events row (market, seq, type, payload,
 * created_at; db/migrations/0011_exchange.sql), written by place_order, cancel_order,
 * record_rejection and refresh_house_ladder (migrations 0013 to 0016): no second event
 * source is ever queried, only the three payload shapes those migrations actually write.
 *
 * book:SYMBOL carries order.accepted, order.cancelled and order.filled, reshaped as:
 *   order.accepted:  { type: "order.accepted", order_id, side, order_type, at }
 *   order.cancelled: { type: "order.cancelled", order_id, reason, at }
 *   order.filled:    { type: "order.filled", price, quantity, notional, at }
 * order.rejected is written to market_events too, but it is not a book change (nothing was
 * ever accepted onto the book to begin with), so it never reaches either channel. at is the
 * row's own created_at, as an ISO string: the one field every shape carries that market_events
 * itself stamps rather than the caller, so it is added here rather than folded into any one
 * payload's own fields.
 *
 * key_id is withheld from order.accepted's own reshaping even though the stored payload
 * carries it: every other public market data read this codebase already ships (getBookLevels
 * and listPublicTrades, src/db/market-data.ts) withholds trader identity from a public,
 * unauthenticated read, and a public book delta stream keeps that the same way rather than
 * becoming the one public read that leaks which key is trading. buy_order_id and
 * sell_order_id are withheld from a fill the same way listPublicTrades already withholds
 * them: "a public tape shows the fill itself, not who was on either side of it."
 *
 * trades:SYMBOL carries only order.filled, reshaped as { price, quantity, notional, at }, the
 * same three fields the public trade tape (GET /v1/exchange/markets/{symbol}/trades) already
 * shows for a fill, with neither order's identity either, plus the row's own created_at.
 */

type ChannelKind = "book" | "trades";
interface Subscription { kind: ChannelKind; market: string }
interface ChannelWant { book: boolean; trades: boolean }

/** The spec's own values. Read once, at request time, by every new connection: overriding a
 * field here only ever changes connections opened after the override, never one already
 * running with the values it captured when it started. */
export const STREAM_DEFAULTS = Object.freeze({
  tailIntervalMs: 1_000,
  heartbeatIntervalMs: 15_000,
  lifetimeMs: 4 * 60_000 + 50_000,
});

/** Mutable so tests/integration/stream.test.ts can override any of the three; restore with
 * Object.assign(streamOptions, STREAM_DEFAULTS) between scenarios. */
export const streamOptions: { tailIntervalMs: number; heartbeatIntervalMs: number; lifetimeMs: number } = { ...STREAM_DEFAULTS };

const MAX_CONCURRENT_STREAMS_PER_IP = 10;

/**
 * Concurrent stream count keyed by req.ip, a plain module level Map rather than deps.cache
 * or deps.limiter: this is deliberately only ever correct for the one function instance
 * holding these particular open connections. A deploy with more than one live instance (or
 * one that recycles this instance between requests) enforces "at most 10" per instance, not
 * globally per address; the spec asks for an in memory counter in the route module, and nothing
 * here pretends it is anything sturdier than that.
 */
const activeStreams = new Map<string, number>();

function trackConnection(ip: string): void {
  activeStreams.set(ip, (activeStreams.get(ip) ?? 0) + 1);
}

function releaseConnection(ip: string): void {
  const next = (activeStreams.get(ip) ?? 1) - 1;
  if (next <= 0) activeStreams.delete(ip); else activeStreams.set(ip, next);
}

function isMarketSymbol(s: string): s is (typeof MARKETS)[number] {
  return (MARKETS as readonly string[]).includes(s);
}

const CHANNEL_RE = /^(book|trades):(.+)$/;
const SEQ_RE = /^(0|[1-9][0-9]*)$/;

/** channels is required and answers validation_failed (422) for an empty value, an
 * unrecognised "kind:SYMBOL" shape, or a well shaped channel naming a market this exchange
 * does not have, all before a single header is sent. */
function parseSubscriptions(raw: unknown): Subscription[] {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw validation("channels is required", [{ path: "channels", message: "at least one book:SYMBOL or trades:SYMBOL channel is required" }]);
  }
  return raw.split(",").map((entry) => {
    const trimmed = entry.trim();
    const match = CHANNEL_RE.exec(trimmed);
    if (!match) throw validation("channels must look like book:SYMBOL or trades:SYMBOL", [{ path: "channels", message: `not a recognised channel: ${trimmed}` }]);
    const kind = match[1] as ChannelKind;
    const market = match[2] as string;
    if (!isMarketSymbol(market)) throw validation("unknown market symbol", [{ path: "channels", message: `unknown market: ${market}` }]);
    return { kind, market };
  });
}

/** since is optional, defaulting to 0 (replay from the start of the market); when present it
 * must be a plain nonnegative integer string. */
function parseSince(raw: unknown): bigint {
  if (raw === undefined) return 0n;
  if (typeof raw !== "string" || !SEQ_RE.test(raw)) {
    throw validation("since must be a nonnegative integer", [{ path: "since", message: "since must be a nonnegative integer" }]);
  }
  return BigInt(raw);
}

interface RawMarketEvent { market: string; seq: string; type: string; payload: Record<string, unknown>; created_at: Date }

/**
 * The most rows one fetchEvents page ever returns. Bounds a replay from since=0 on a long
 * history, and a burst caught in one tail tick, to one page in memory and one page written
 * at a time rather than the whole backlog at once: pump() below loops, re-querying with each
 * market's bound advanced to the last row it actually sent, for as long as a page comes back
 * full (a page shorter than the limit is proof nothing subscribed is left to send).
 */
const EVENTS_PAGE_LIMIT = 500;

/**
 * One query for every subscribed market, spec's own wording for the tail: bounds pairs each
 * market with the seq already sent for it, joined against market_events through unnest's
 * parallel array form rather than issued as one query per market. Used identically for the
 * initial replay (every bound is the request's own since) and every later tail tick (every
 * bound is that market's own last sent seq). Capped at EVENTS_PAGE_LIMIT rows, ordered by
 * market then seq, so a caller that keeps re-querying with each market's bound advanced to
 * what it actually sent drains an arbitrarily long backlog a page at a time, skipping nothing
 * and repeating nothing.
 */
async function fetchEvents(pool: Pool, bounds: Map<string, bigint>): Promise<RawMarketEvent[]> {
  const markets = [...bounds.keys()];
  if (markets.length === 0) return [];
  const sinceValues = markets.map((m) => (bounds.get(m) as bigint).toString());
  const { rows } = await pool.query<RawMarketEvent>(
    `select me.market, me.seq::text as seq, me.type, me.payload, me.created_at
     from market_events me
     join unnest($1::text[], $2::bigint[]) as bounds(market, since) on me.market = bounds.market
     where me.seq > bounds.since
     order by me.market, me.seq
     limit $3`,
    [markets, sinceValues, EVENTS_PAGE_LIMIT]);
  return rows;
}

function bookDelta(row: RawMarketEvent): Record<string, unknown> | null {
  const p = row.payload;
  const at = row.created_at.toISOString();
  switch (row.type) {
    case "order.accepted": return { type: "order.accepted", order_id: p.order_id, side: p.side, order_type: p.type, at };
    case "order.cancelled": return { type: "order.cancelled", order_id: p.order_id, reason: p.reason, at };
    case "order.filled": return { type: "order.filled", price: p.price, quantity: p.quantity, notional: p.notional, at };
    default: return null;
  }
}

function tradeDelta(row: RawMarketEvent): Record<string, unknown> | null {
  if (row.type !== "order.filled") return null;
  const p = row.payload;
  return { price: p.price, quantity: p.quantity, notional: p.notional, at: row.created_at.toISOString() };
}

function frameText(name: string, data: unknown, id?: string): string {
  const lines: string[] = [];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`event: ${name}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  return lines.join("\n") + "\n\n";
}

/** Exported only so tests/unit/exchange-stream.test.ts can drive it directly against a fake
 * request and response, to prove the backpressure pause and resume deterministically without
 * a real socket. mountStream below is still the one real caller in production. */
export async function streamHandler(req: Request, res: Response, deps: AppDeps): Promise<void> {
  const subscriptions = parseSubscriptions(req.query.channels);
  const since = parseSince(req.query.since);

  const ip = req.ip ?? "unknown";

  // The stream bucket (spec 10.7): 12 opens a minute per address, charged through the same
  // shared limiter every other rate limited route uses (memory in tests, Upstash in
  // production), before the local concurrency check below ever runs. A caller rate limited
  // here never reaches trackConnection, so it never counts against the concurrency cap
  // either; the two are independent ceilings, not one enforcing the other.
  const rateResult = await limitWithTimeout(deps, "stream", ip);
  const resetSeconds = applyRateLimitHeaders(res, rateResult);
  if (!rateResult.ok) {
    throw new ApiError(429, "rate_limited", "at most 12 stream opens per minute per address", undefined, { "Retry-After": String(resetSeconds) });
  }

  if ((activeStreams.get(ip) ?? 0) >= MAX_CONCURRENT_STREAMS_PER_IP) {
    throw new ApiError(429, "rate_limited", "at most 10 concurrent streams per address");
  }

  const wants = new Map<string, ChannelWant>();
  for (const s of subscriptions) {
    const entry = wants.get(s.market) ?? { book: false, trades: false };
    entry[s.kind] = true;
    wants.set(s.market, entry);
  }

  const lastSeq = new Map<string, bigint>();
  for (const market of wants.keys()) lastSeq.set(market, since);

  trackConnection(ip);
  let closed = false;
  // A plain object, not three separate `let`s: cleanup below closes over this and can run at
  // any time, including before any timer has been created (an immediate req.on("close"), or
  // the replay's own catch block), so each field genuinely needs to start out unset rather
  // than declared just ahead of its own assignment.
  const timers: { tail?: ReturnType<typeof setInterval>; heartbeat?: ReturnType<typeof setInterval>; lifetime?: ReturnType<typeof setTimeout> } = {};

  function cleanup(): void {
    if (closed) return;
    closed = true;
    if (timers.tail) clearInterval(timers.tail);
    if (timers.heartbeat) clearInterval(timers.heartbeat);
    if (timers.lifetime) clearTimeout(timers.lifetime);
    releaseConnection(ip);
  }

  req.on("close", cleanup);

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.status(200);
  res.flushHeaders();

  // A slow reader must never make this route buffer an unbounded amount of unsent data
  // over a connection that can live four minutes fifty seconds: paused tracks whatever
  // res.write's own return value last said, and every writer (the replay, the tail, the
  // heartbeat) checks it before adding more rather than only the one call site that first
  // saw it go false. waitForDrain resolves on the socket's own drain event, or immediately
  // on the request closing while paused, so a reader that vanishes mid backlog never leaves
  // pump() awaiting a drain that will now never come.
  let paused = false;

  function send(chunk: string): void {
    if (!res.write(chunk)) paused = true;
  }

  function waitForDrain(): Promise<void> {
    return new Promise((resolve) => {
      function onDrain(): void { req.off("close", onClose); paused = false; resolve(); }
      function onClose(): void { res.off("drain", onDrain); resolve(); }
      res.once("drain", onDrain);
      req.once("close", onClose);
    });
  }

  async function backpressure(): Promise<void> {
    if (paused) await waitForDrain();
  }

  function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => { setImmediate(resolve); });
  }

  // Publishes one row, waiting out any backpressure between each frame it writes, then
  // advances that market's own last sent seq only once every frame for the row is safely
  // written: a resumed pump never re-sends a half written row, and never skips one either.
  async function publishRow(row: RawMarketEvent): Promise<void> {
    const want = wants.get(row.market);
    if (want) {
      if (want.book) {
        const delta = bookDelta(row);
        if (delta) {
          send(frameText("message", { channel: `book:${row.market}`, seq: row.seq, data: delta }, row.seq));
          await backpressure();
        }
      }
      if (want.trades) {
        const delta = tradeDelta(row);
        if (delta) {
          send(frameText("message", { channel: `trades:${row.market}`, seq: row.seq, data: delta }, row.seq));
          await backpressure();
        }
      }
    }
    const seen = lastSeq.get(row.market) ?? since;
    const seq = BigInt(row.seq);
    if (seq > seen) lastSeq.set(row.market, seq);
  }

  // Drains every row currently owed to this connection, one EVENTS_PAGE_LIMIT page at a
  // time, re-querying with each market's bound advanced to the last seq it actually sent.
  // A page shorter than the limit proves nothing subscribed is left to send, so the loop
  // stops there; a full page means more may still be waiting, so it yields to the event
  // loop (rather than looping straight back into another query and write burst) before
  // asking again. Used identically for the initial replay and every later tail tick, so
  // a huge replay from since=0 and a burst caught in one tail tick are bounded the same way.
  async function pump(): Promise<void> {
    for (;;) {
      if (closed) return;
      const rows = await fetchEvents(deps.pool, lastSeq);
      if (closed) return;
      for (const row of rows) {
        if (closed) return;
        await publishRow(row);
      }
      if (rows.length < EVENTS_PAGE_LIMIT) return;
      if (closed) return;
      await yieldToEventLoop();
    }
  }

  // A query failure, replay or tail, never kills the process: it is caught, logged, and ends
  // this one stream, exactly like any other reader losing its connection.
  try {
    await pump();
  } catch (err) {
    deps.logger.error({ err: (err as Error).message }, "exchange stream replay failed");
    cleanup();
    res.end();
    return;
  }
  if (closed) return;

  let tailRunning = false;
  timers.tail = setInterval(() => {
    if (closed || tailRunning) return;
    tailRunning = true;
    pump()
      .catch((err: unknown) => {
        deps.logger.error({ err: (err as Error).message }, "exchange stream tail failed");
        cleanup();
        res.end();
      })
      .finally(() => { tailRunning = false; });
  }, streamOptions.tailIntervalMs);

  timers.heartbeat = setInterval(() => {
    if (closed || paused) return;
    send(": heartbeat\n\n");
    // The heartbeat can be the write that tips the socket over its high water mark, so it
    // registers the drain listener like every row write does; otherwise paused stays true.
    if (paused) void backpressure();
  }, streamOptions.heartbeatIntervalMs);

  timers.lifetime = setTimeout(() => {
    if (closed) return;
    send(frameText("reconnect", { reason: "reconnect" }));
    cleanup();
    res.end();
  }, streamOptions.lifetimeMs);
}

export function mountStream(app: Express, deps: AppDeps): void {
  app.get("/v1/exchange/stream", (req, res, next) => {
    streamHandler(req, res, deps).catch(next);
  });
}

/**
 * A minimal, hand written path item: this route carries no defineRoute entry (it streams, so
 * it never goes through src/platform/route.ts's mountRoutes, spec whose own JSON response
 * handling this route cannot use), so ROUTE_REGISTRY never sees it and buildOpenApi
 * (src/schemas/openapi.ts) cannot generate an entry for it the way it does for every other
 * route. src/routes/docs.ts merges this in by hand instead.
 */
export const streamOpenApiPath: Record<string, Record<string, unknown>> = {
  get: {
    summary:
      "The public market event stream over Server-Sent Events (spec 10.7; shipped as SSE, not the WebSocket the spec section is headed with, since no WebSocket upgrade reaches an Express app deployed as a Vercel Function on this account). Replays every market_events row after since for the subscribed channels, in seq order, a page at a time, then tails once a second. book:SYMBOL carries order.accepted as {type,order_id,side,order_type,at}, order.cancelled as {type,order_id,reason,at}, and order.filled as {type,price,quantity,notional,at}. trades:SYMBOL carries only order.filled, as {price,quantity,notional,at}. at is the row's own created_at as an ISO string. A slow reader is paused rather than dropped: nothing is skipped and nothing is sent twice once it catches up. A heartbeat comment every 15 seconds; a reconnect event and the end of the response at four minutes fifty seconds. Public, no key, at most 12 opens a minute per address and at most 10 concurrent streams per address.",
    tags: ["Exchange"],
    operationId: "get_v1_exchange_stream",
    parameters: [
      { name: "channels", in: "query", required: true, schema: { type: "string" }, description: "Comma separated book:SYMBOL or trades:SYMBOL channels, e.g. book:BTC-USDT,trades:BTC-USDT" },
      { name: "since", in: "query", required: false, schema: { type: "string" }, description: "Replay every event with seq greater than this value; defaults to 0" },
    ],
    responses: {
      "200": { description: "A Server-Sent Events stream: repeated event: message frames carrying {channel, seq, data}, occasional heartbeat comments, and a final event: reconnect frame", content: { "text/event-stream": { schema: { type: "string" } } } },
      "422": { description: "Problem details", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } },
      "429": { description: "Problem details", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } },
    },
  },
};
