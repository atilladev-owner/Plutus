# Milestone Two, The Exchange, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A paper trading exchange on top of the milestone one ledger: two markets, limit and market orders matched inside one Postgres function, a house market maker that quotes around the real price, public market data and a live event stream, signed requests, and a public proof that the exchange cannot create or destroy money.

**Architecture:** The exchange is one system ledger, `ldg_exchange`, owned by a house key created by migration. Every order is a hold on that ledger and every fill is one ledger transfer with three legs, so the milestone one invariants and the verify endpoint cover the exchange for free. Matching runs in `place_order`, a plpgsql function serialised per market by an advisory lock. The house has no loop: a read or a placement that finds the ladder older than 15 seconds refreshes it first. Market data is read from SQL and cached in Redis for two seconds. The stream is Server Sent Events with gapless per market sequence numbers.

**Tech Stack:** Everything from milestone one. No new runtime dependencies except none; the price fetch uses `fetch`, the stream uses Node's response streaming, signing uses `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-09-04-plutus-design.md`, sections 3 (milestone two), 10, 12, 13, 14. Section 10 is the binding text for every number, name and rule below. Where this plan and the spec disagree, the spec wins, and the implementer says so in the report.

**Plan style, a recorded ruling:** unlike the milestone one plan, this plan does not carry the full code of every file. It carries exact interfaces, SQL signatures, names, numbers, error codes and test cases; the implementer writes bodies from the spec section named in each task. Reason: writing the matching engine twice, once here and once in the repo, costs more than a review round, and the owner asked to conserve tokens. Reviewers check spec compliance against section 10, not against this plan's prose.

## Global Constraints

- Money is integer minor units: BIGINT in Postgres, `bigint` in TypeScript, strings in JSON. No floats anywhere in matching, fees or notional. `notional = price * quantity / 10^base_exponent` is exact by the market check constraint (spec 10.1).
- All money writes go through the milestone one SQL functions (`post_transfer`, `create_hold`, `release_hold`, `capture_close_hold`) called from `place_order` and friends. No direct balance updates.
- Lock order is fixed: market advisory locks in symbol order, then the ledger row, then accounts in ascending id order (spec 10.4 step 7).
- Every accept, fill, cancel and rejection is a row in `market_events` with a per market gapless `seq`, and an event for the trading key typed `order.accepted`, `order.filled`, `order.cancelled`, `order.rejected`.
- House rules from milestone one: no console.*, parseFloat, toFixed, Math.round/floor/ceil, or `any` in src; no emoji and no em or en dashes anywhere; `npm run build` must be clean; no dashes as punctuation; no pills on the page.
- Commits: author Atilla Dev, plain imperative subjects, no trailers, no assistant or model mention anywhere.
- The stream ships as Server Sent Events, not WebSocket. Ruling: SSE is certain to work on Vercel Functions, the spec (10.7) allows it with the identical message and sequence contract, and it saves a deploy round trip for a spike. The docs say which one it is.
- Reference price source: Coinbase spot, `GET https://api.coinbase.com/v2/prices/{BASE}-USDT/spot`, reply `{"data":{"amount":"79924.965","base":"BTC","currency":"USDT"}}`. Parse the amount as a decimal string into quote minor units without floats. On any failure keep the stored `reference_price` (spec 10.5).

---

### Task 1: Exchange schema and the house

**Files:**
- Create: `db/migrations/0011_exchange.sql`
- Create: `src/db/exchange.ts` (row types and read helpers used by later tasks)
- Test: `tests/integration/exchange-schema.test.ts`

**Interfaces:**
- Produces: tables `markets`, `orders`, `trades`, `market_events`, `faucets`; the system ledger `ldg_exchange`; the house key `key_house` with accounts per asset and a fee account per quote asset; constants `EXCHANGE_LEDGER_ID = "ldg_exchange"`, `HOUSE_KEY_ID`, `MARKETS = ["BTC-USDT", "ETH-USDT"] as const`.
- Consumes: `assets`, `ledgers`, `accounts`, `api_keys` from milestone one.

- [ ] **Step 1: Failing test.** `exchange-schema.test.ts` asserts after migration: two market rows with the exact tick, lot and min notional values from spec 10.1; the check constraint `tick_size * lot_size % 10^base_exponent = 0` rejects an insert of a market with tick 3 and lot 7 for BTC; `ldg_exchange` exists and belongs to the house key; the house has accounts for BTC, ETH and USDT with balances 10,000 BTC, 100,000 ETH and 1,000,000,000 USDT in minor units, and one fee account per quote asset (USDT) named `fee:USDT`; the world account balance for each asset equals the negative of the sum of house balances, so `verify` of `ldg_exchange` passes with `ok: true` on the fresh ledger.
- [ ] **Step 2: Migration.** Columns exactly as spec 10.1 and 10.3, plus `trades(id, market, seq, buy_order_id, sell_order_id, price, quantity, notional, buyer_fee, seller_fee, transfer_id, created_at)`, `market_events(market, seq, type, payload jsonb, created_at, primary key (market, seq))`, `faucets(key_id primary key, last_at timestamptz)`. Index `orders (market, side, price, created_at) where status in ('open','partially_filled')` for the walk. The house funding runs through `post_transfer` from the world so the journal records it. The house key's secret hash is a random value never printed; the house never signs anything.
- [ ] **Step 3: Run the test, green. Commit:** `Add the exchange schema, the house key, and the exchange ledger`.

### Task 2: Signed requests and endpoint weights

**Files:**
- Create: `src/platform/signing.ts`, `src/platform/weights.ts`
- Modify: `src/platform/route.ts` (RouteDef gains `auth: "signed"` and `weight?: number`), `src/platform/middleware.ts`
- Test: `tests/unit/signing.test.ts`, `tests/integration/signing.test.ts`, `tests/integration/weights.test.ts`

**Interfaces:**
- Produces: `signRequest({ keyId, secret, method, path, body, timestamp, recvWindow? })` returning the four header values (spec 10.8), used by tests and by `docs/place-order.mjs`; `signedAuth` middleware that resolves the key by `X-Plutus-Key-Id`, verifies the HMAC with `safeEqual`, and sets `res.locals.key` exactly like `bearerAuth`; `weightLimit(def)` middleware charging `def.weight` against 1,200 per minute per key and a separate 10 per second cap on order placement (spec 10.9), returning 429 with the same `RateLimit` headers milestone one emits.
- Signature string: `timestamp + "\n" + METHOD + "\n" + path + "\n" + body`, where `path` is the request path with query string and `body` is the raw bytes captured by the JSON verify hook (empty string when there is no body).

- [ ] **Step 1: Failing tests.** Unit: a known vector (fixed secret, timestamp 1700000000000, `POST`, `/v1/exchange/orders`, body `{"a":1}`) produces a fixed hex signature the test pins; the same inputs with one byte changed in the body produce a different signature. Integration: a signed `GET /v1/exchange/balances` returns 200; missing headers 401 `invalid_signature`; timestamp 6,000 ms old with default window 401 `timestamp_out_of_window`; 6,000 ms old with `X-Plutus-Recv-Window: 10000` 200; window above 60,000 clamps to 60,000; tampered body 401 `invalid_signature`; a bearer token on a signed route 401. Weights: a key spending 1,200 weight in a minute gets 429 on the next call with `RateLimit-Remaining: 0`; the eleventh placement in one second gets 429 while a balance read still passes.
- [ ] **Step 2: Implement.** Under `NODE_ENV=test` without Upstash, weights use the same memory limiter milestone one uses. The placement cap is a second limiter keyed `place:<key>`.
- [ ] **Step 3: Green, build, commit:** `Add signed request authentication and endpoint weights for the exchange`.

### Task 3: Wallets, faucet and reset

**Files:**
- Create: `src/routes/exchange-wallet.ts`, `src/schemas/exchange.ts`, `db/migrations/0012_exchange_wallet.sql` (functions `exchange_faucet(p_key_id, p_now)` and `exchange_reset(p_key_id, p_now)`)
- Modify: `src/routes/index.ts`
- Test: `tests/integration/exchange-wallet.test.ts`

**Interfaces:**
- Produces: `POST /v1/exchange/faucet` (signed, scope `exchange:trade`, sandbox keys only) creating the key's accounts in `ldg_exchange` on first call and funding 100,000 USDT, 1 BTC, 10 ETH from the world, once per 24 hours per key, else 429 `faucet_cooldown` with `Retry-After`; `POST /v1/exchange/reset` cancelling every open order of the key (Task 5 owns cancellation; until then reset only releases holds and refunds), releasing every hold, and moving balances back to the faucet amounts through transfers to and from the world; `GET /v1/exchange/balances` listing `{ asset, balance, held, available }` as strings.
- Live keys: faucet and reset return 403 `sandbox_only`.

- [ ] **Step 1: Failing tests.** Faucet once: balances exactly the three amounts; twice within 24 hours: 429 with `Retry-After` and unchanged balances; reset after a transfer moved 1 BTC worth of USDT out: balances back to faucet amounts and `verify` of `ldg_exchange` still `ok: true`; a live key gets 403.
- [ ] **Step 2: Implement.** Reset takes every market advisory lock in symbol order first (spec 10.4 step 7) even before Task 5 exists, so the lock order never changes later.
- [ ] **Step 3: Green, build, commit:** `Add exchange wallets with a daily faucet and a sandbox reset`.

### Task 4: The matching function

**Files:**
- Create: `db/migrations/0013_place_order.sql` (functions `place_order(...)`, `cancel_order(...)`, `next_market_seq(...)`, `append_market_event(...)`)
- Test: `tests/integration/matching.test.ts` (calls the SQL functions directly through a small wrapper in `src/db/exchange.ts`)

**Interfaces:**
- Produces: `place_order(p_key_id text, p_order_id text, p_market text, p_client_order_id text, p_side text, p_type text, p_tif text, p_post_only boolean, p_price bigint, p_quantity bigint, p_quote_amount bigint, p_now timestamptz) returns jsonb` with `{ order, trades: [...], event_ids: [...] }` or raises `order_rejected` with `detail` set to one of the eight reasons in spec 10.3; `cancel_order(p_key_id, p_order_id, p_now) returns jsonb`.
- Fees: `ceil(notional * bps / 10000)` computed as `(notional * bps + 9999) / 10000` in integer arithmetic; maker and taker both 10 bps seeded.
- Fill transfer legs exactly as spec 10.4 step 4, three legs, one `post_transfer` call per fill.
- Market buy fillable quantity per level: the largest multiple of the lot whose notional plus buyer fee fits the remaining quote.

- [ ] **Step 1: Failing tests, one per rule.** (a) A limit buy rests on an empty book with a hold of `notional + fee` in USDT and status `open`. (b) A limit sell crossing it fills at the resting price, produces one trade, one transfer with three legs whose amounts the test computes by hand (price 80,000.00 USDT, quantity 0.001 BTC: notional 8,000,000, fee 8,000 each side), balances on both sides exact, holds closed or reduced exactly. (c) Partial fill leaves `partially_filled` with the remaining hold. (d) `post_only` that would take: `post_only_would_take`, no fill, no hold left open. (e) `FOK` not fillable in full: `fok_not_fillable`, book unchanged. (f) `IOC` fills what it can and cancels the rest with the hold released. (g) Market buy with `quote_amount` fills the largest lot multiple that fits including fee, at two levels. (h) Price not a tick multiple, quantity not a lot multiple, below min notional, halted market, duplicate `client_order_id`, insufficient funds: each named reason. (i) After every scenario `verify` of `ldg_exchange` is `ok: true` and each market's `market_events` seq is gapless.
- [ ] **Step 2: Implement per spec 10.4.** Advisory lock on the market first. FOK and post_only run the walk as a dry run before any write.
- [ ] **Step 3: Green, build, commit:** `Add the matching function with price time priority, holds for margin, and exact fees`.

### Task 5: Orders API

**Files:**
- Create: `src/routes/exchange-orders.ts`
- Modify: `src/schemas/exchange.ts`, `src/routes/index.ts`, `src/routes/exchange-wallet.ts` (reset now cancels through `cancel_order`)
- Test: `tests/integration/exchange-orders.test.ts`

**Interfaces:**
- Produces the signed endpoints of spec 10.10 for orders: place (weight 1, placement cap), cancel one by id or `client_order_id`, cancel all optionally per market, list with `status` filter and cursor pagination, get one, my trades. Every transition fans out events to the trading key so webhooks fire (`afterCommit` from milestone one).
- Order JSON: every money field a string; `status`, `reject_reason`, `accepted_seq` present.

- [ ] **Step 1: Failing tests.** Place then get: same body; list `status=open` contains it; cancel by `client_order_id` releases the hold; cancel all with `market=` leaves the other market's orders; a webhook endpoint subscribed to `order.filled` receives the fill event through the memory scheduler; a rejected order returns 422 `order_rejected` with `reason` in the body and appears in history with status `rejected`.
- [ ] **Step 2: Implement.** Idempotency: `client_order_id` is the handle; the same `client_order_id` twice returns the first order with `Idempotent-Replayed: true` rather than `duplicate_client_order_id` when the body is byte identical, and the rejection when it differs.
- [ ] **Step 3: Green, build, commit:** `Add the exchange order endpoints and fan out order events to webhooks`.

### Task 6: The house market maker

**Files:**
- Create: `src/platform/reference-price.ts`, `db/migrations/0014_house_ladder.sql` (`refresh_house_ladder(p_market, p_reference_price bigint, p_now)`), `src/routes/exchange-house.ts` (the `ensureFreshLadder(deps, market)` helper used by reads and placements)
- Modify: `src/routes/internal.ts` (sweep refreshes cold markets and tops up the house), `src/db/ledger.ts` only if a helper is missing
- Test: `tests/unit/reference-price.test.ts`, `tests/integration/house.test.ts`

**Interfaces:**
- `fetchReferencePrice(market, fetchImpl?)` returns quote minor units per whole base unit as `bigint` or `null`, cached in Redis (or memory in tests) for 10 seconds, parsed from the Coinbase reply without floats (split on the dot, pad to the quote exponent).
- `refresh_house_ladder` cancels open house orders on the market and places five bids and five asks at reference minus and plus `(10 + 5 i)` bps for i in 0..4, rounded to the tick, quantity `base_size * 2^i` with base size 0.05 BTC or 1 ETH, and sets `house_quoted_at` and `reference_price`.
- `ensureFreshLadder` runs before any book, ticker, trades, candles read and any placement when `house_quoted_at` is older than 15 seconds, under the market lock; skips quoting when no reference price is known.
- Sweep: refresh markets older than 15 seconds and top up any house account below a quarter of its seed from the world; response gains `house_topups` and `markets_refreshed`.

- [ ] **Step 1: Failing tests.** Parser: `"79924.965"` becomes `79924965000n` for USDT (exponent 6); `"0.5"` becomes `500000n`; garbage returns `null`. House: with a fake fetch returning 80,000 USDT, a book read shows five bids and five asks at the spec prices rounded to tick with doubling sizes; a second read within 15 seconds does not refetch (fake counts calls); after 16 seconds it does; with the fetch failing the previous ladder stays; a trader's market buy fills against the house and `verify` stays `ok: true`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Green, build, commit:** `Add the house market maker that quotes a ladder around the reference price when someone looks`.

### Task 7: Market data and the public proof

**Files:**
- Create: `src/routes/exchange-market-data.ts`, `src/db/market-data.ts`
- Modify: `src/routes/index.ts`, `src/platform/cache.ts` if a helper is missing
- Test: `tests/integration/market-data.test.ts`

**Interfaces:** the five public endpoints of spec 10.6 with the exact query parameters and limits, cached two seconds; `GET /v1/exchange/verify` public, 2 calls per minute per IP, returning the milestone one verify document for `ldg_exchange`. Candles aggregated in SQL with `date_bin`.

- [ ] **Step 1: Failing tests.** Book depth aggregation by price with `seq`; trades newest first; ticker fields after two trades; candles for 1m with open, high, low, close, volume computed by hand from three trades; depth 0 and 101 rejected 422; a second read within two seconds is served from cache (fake clock or counting the SQL calls); verify public and limited: third call within a minute 429.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Green, build, commit:** `Add public market data endpoints and the public proof for the exchange ledger`.

### Task 8: The event stream

**Files:**
- Create: `src/routes/exchange-stream.ts`
- Test: `tests/integration/stream.test.ts`

**Interfaces:** `GET /v1/exchange/stream?channels=book:BTC-USDT,trades:BTC-USDT&since=<seq>` responds `text/event-stream`. It replays every `market_events` row after `since` for the requested channels (book channel carries accepts, cancels and fills as deltas; trades channel carries fills), then tails once a second, each message `event: message` with data `{ channel, seq, data }`; a comment line heartbeat every 15 seconds; at four minutes fifty seconds it sends `event: reconnect` and ends the response. Public, no auth, at most 10 concurrent streams per IP.

- [ ] **Step 1: Failing tests.** Using supertest's stream or a raw `http` request: with `since=0` on a market with three events the client receives exactly three messages in seq order then a heartbeat comment; a new order placed during the tail arrives within two seconds; a client reconnecting with `since=<last seq>` receives only newer events, none missing, none repeated; the reconnect event fires at the limit (fake the clock or make the limit injectable).
- [ ] **Step 2: Implement.** Write through `res.write`, flush headers immediately, honour `req.on("close")`.
- [ ] **Step 3: Green, build, commit:** `Add the market event stream over Server Sent Events with gapless replay`.

### Task 9: The randomised session and mutations

**Files:**
- Create: `tests/property/exchange.property.test.ts`
- Modify: `scripts/mutate.mjs` (two exchange mutants)
- Test: as above

- [ ] **Step 1: The session.** Five keys faucet, then at least one thousand random orders across both markets: limit and market, both sides, random tick aligned prices within 5 percent of the reference, random lot aligned sizes, random time in force, a few cancels. Rate limits overridden as in milestone one. Assertions after the session: `verify` of `ldg_exchange` is `ok: true`; for every asset the sum of all account balances including the world is zero; every key's `held` equals the sum of its open orders' hold remainders; every market's `market_events` is gapless; every filled order's `filled_quote` equals the sum of its trades' notional.
- [ ] **Step 2: Mutants that must go red.** In `place_order`: the base leg of the fill transfer removed (verify red); the fee formula floor instead of ceil (the hand computed fee test red). Anchors verified once and guarded as before.
- [ ] **Step 3: Green, `npm run test:mutation` prints five caught lines, commit:** `Prove the exchange conserves money across a random session and breaks loudly under mutation`.

### Task 10: Docs, the page, the guide and the outside order

**Files:**
- Modify: `src/schemas/openapi.ts` if signed auth needs a second security scheme; `README.md`; `public/index.html`
- Create: `docs/place-order.mjs`, `docs/how-it-works.md`
- Test: `tests/contract/openapi.test.ts` gains assertions that every exchange route is documented

**The page, a design brief the implementer follows exactly.** Reading: a reference document for developers, in a quiet technical register, same palette and type as today. Layout on desktop: a left side panel 260px wide, sticky, listing the sections as plain links, and the document to its right at 65ch; on narrow screens the panel becomes a list at the top. Sections in order: What it is; How it works (ledger, holds, journal, matching, the house); What to build with it (the four examples: savings groups, group expenses, tabs, deposits); Set it up (mint a key, first three calls, signing for trading, the faucet); Limits (the two tables); Verify it (the two public verify URLs); Source and licence. The thirty second block stays. No pills, no icons, no emoji, no dashes as punctuation, one accent, radius 14px maximum, both themes, AA contrast computed and written into the report.

**The guide, `docs/how-it-works.md`,** is for the owner, in plain words, no jargon without a one line explanation: what each part does, why it is built that way, what went wrong during the build and what it taught, how to make a change safely (branch, test, review, deploy), and how to read a review finding. About two thousand words.

**`docs/place-order.mjs`** signs and places one limit order from any folder: reads `PLUTUS_KEY_ID` and `PLUTUS_SECRET` from the environment, prints the order id and status, never prints the secret. This satisfies acceptance 5 when the owner runs it from outside the repo.

- [ ] **Step 1: OpenAPI and README.** README gains an Exchange section: what it is, the faucet, one signed call, the public verify URL, the market maker explained plainly, the honest throughput number, the stream being SSE. Test count updated to the real number.
- [ ] **Step 2: The page.**
- [ ] **Step 3: The guide and the script.**
- [ ] **Step 4: Build, whole suite, commit:** `Document the exchange, rebuild the landing page as a guide, and add the outside order script`.

### Task 11: Deploy, prove it live, and the operator walkthrough

By hand, with the owner, one step at a time in plain words:

1. `npm run migrate` against Neon applies 0011 to 0014. The owner runs the deploy command. Live smoke: faucet, a signed order that fills against the house, the public book showing the ladder, the public verify passing, the stream replaying, `docs/place-order.mjs` run from the owner's home folder placing one order.
2. GlitchTip: the owner creates a project and adds its DSN as `SENTRY_DSN` in the Vercel dashboard; a deliberate 500 appears in GlitchTip.
3. The CI token: the owner creates a dedicated Vercel token and replaces the repository secret, explained screen by screen.
4. Portfolio card stats updated to the real test count.

---

**Self review.** Spec coverage: 10.1 Task 1; 10.2 Task 3; 10.3 and 10.4 Task 4 and 5; 10.5 Task 6; 10.6 Task 7; 10.7 Task 8 as SSE by ruling; 10.8 and 10.9 Task 2; 10.10 Tasks 3, 5, 7, 8; section 3 acceptance 1 Tasks 3 to 6, 2 Task 9, 3 Task 2, 4 Task 8, 5 Task 10 and 11; section 14 Task 10. Gaps named: the WebSocket spike is replaced by the SSE ruling; the daily faucet is per key not per IP, as the spec says.
