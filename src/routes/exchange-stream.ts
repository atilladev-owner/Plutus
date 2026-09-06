import type { Express, Request, Response } from "express";
import type { Pool } from "pg";
import { ApiError, validation } from "../domain/errors.js";
import { MARKETS } from "../db/exchange.js";
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
 *   order.accepted:  { type: "order.accepted", order_id, side, order_type }
 *   order.cancelled: { type: "order.cancelled", order_id, reason }
 *   order.filled:    { type: "order.filled", price, quantity, notional }
 * order.rejected is written to market_events too, but it is not a book change (nothing was
 * ever accepted onto the book to begin with), so it never reaches either channel.
 *
 * key_id is withheld from order.accepted's own reshaping even though the stored payload
 * carries it: every other public market data read this codebase already ships (getBookLevels
 * and listPublicTrades, src/db/market-data.ts) withholds trader identity from a public,
 * unauthenticated read, and a public book delta stream keeps that the same way rather than
 * becoming the one public read that leaks which key is trading. buy_order_id and
 * sell_order_id are withheld from a fill the same way listPublicTrades already withholds
 * them: "a public tape shows the fill itself, not who was on either side of it."
 *
 * trades:SYMBOL carries only order.filled, reshaped as { price, quantity, notional }, the
 * same three fields the public trade tape (GET /v1/exchange/markets/{symbol}/trades) already
 * shows for a fill, with neither order's identity either.
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

interface RawMarketEvent { market: string; seq: string; type: string; payload: Record<string, unknown> }

/**
 * One query for every subscribed market, spec's own wording for the tail: bounds pairs each
 * market with the seq already sent for it, joined against market_events through unnest's
 * parallel array form rather than issued as one query per market. Used identically for the
 * initial replay (every bound is the request's own since) and every later tail tick (every
 * bound is that market's own last sent seq).
 */
async function fetchEvents(pool: Pool, bounds: Map<string, bigint>): Promise<RawMarketEvent[]> {
  const markets = [...bounds.keys()];
  if (markets.length === 0) return [];
  const sinceValues = markets.map((m) => (bounds.get(m) as bigint).toString());
  const { rows } = await pool.query<RawMarketEvent>(
    `select me.market, me.seq::text as seq, me.type, me.payload
     from market_events me
     join unnest($1::text[], $2::bigint[]) as bounds(market, since) on me.market = bounds.market
     where me.seq > bounds.since
     order by me.market, me.seq`,
    [markets, sinceValues]);
  return rows;
}

function bookDelta(row: RawMarketEvent): Record<string, unknown> | null {
  const p = row.payload;
  switch (row.type) {
    case "order.accepted": return { type: "order.accepted", order_id: p.order_id, side: p.side, order_type: p.type };
    case "order.cancelled": return { type: "order.cancelled", order_id: p.order_id, reason: p.reason };
    case "order.filled": return { type: "order.filled", price: p.price, quantity: p.quantity, notional: p.notional };
    default: return null;
  }
}

function tradeDelta(row: RawMarketEvent): Record<string, unknown> | null {
  if (row.type !== "order.filled") return null;
  const p = row.payload;
  return { price: p.price, quantity: p.quantity, notional: p.notional };
}

function writeFrame(res: Response, name: string, data: unknown, id?: string): void {
  const lines: string[] = [];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`event: ${name}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  res.write(lines.join("\n") + "\n\n");
}

async function streamHandler(req: Request, res: Response, deps: AppDeps): Promise<void> {
  const subscriptions = parseSubscriptions(req.query.channels);
  const since = parseSince(req.query.since);

  const ip = req.ip ?? "unknown";
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

  function publish(rows: RawMarketEvent[]): void {
    for (const row of rows) {
      const want = wants.get(row.market);
      if (want) {
        if (want.book) {
          const delta = bookDelta(row);
          if (delta) writeFrame(res, "message", { channel: `book:${row.market}`, seq: row.seq, data: delta }, row.seq);
        }
        if (want.trades) {
          const delta = tradeDelta(row);
          if (delta) writeFrame(res, "message", { channel: `trades:${row.market}`, seq: row.seq, data: delta }, row.seq);
        }
      }
      const seen = lastSeq.get(row.market) ?? since;
      const seq = BigInt(row.seq);
      if (seq > seen) lastSeq.set(row.market, seq);
    }
  }

  // A query failure, replay or tail, never kills the process: it is caught, logged, and ends
  // this one stream, exactly like any other reader losing its connection.
  try {
    publish(await fetchEvents(deps.pool, lastSeq));
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
    fetchEvents(deps.pool, lastSeq)
      .then((rows) => { if (!closed) publish(rows); })
      .catch((err: unknown) => {
        deps.logger.error({ err: (err as Error).message }, "exchange stream tail failed");
        cleanup();
        res.end();
      })
      .finally(() => { tailRunning = false; });
  }, streamOptions.tailIntervalMs);

  timers.heartbeat = setInterval(() => {
    if (!closed) res.write(": heartbeat\n\n");
  }, streamOptions.heartbeatIntervalMs);

  timers.lifetime = setTimeout(() => {
    if (closed) return;
    writeFrame(res, "reconnect", { reason: "reconnect" });
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
      "The public market event stream over Server-Sent Events (spec 10.7; shipped as SSE, not the WebSocket the spec section is headed with, since no WebSocket upgrade reaches an Express app deployed as a Vercel Function on this account). Replays every market_events row after since for the subscribed channels, in seq order, then tails once a second. book:SYMBOL carries order.accepted as {type,order_id,side,order_type}, order.cancelled as {type,order_id,reason}, and order.filled as {type,price,quantity,notional}. trades:SYMBOL carries only order.filled, as {price,quantity,notional}. A heartbeat comment every 15 seconds; a reconnect event and the end of the response at four minutes fifty seconds. Public, no key, at most 10 concurrent streams per address.",
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
