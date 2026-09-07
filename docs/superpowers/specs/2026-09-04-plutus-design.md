# Plutus, design spec

Date: 2026-09-04
Status: approved in conversation, not yet planned or built
Repository: `github.com/atilladev-owner/Plutus`, public, PolyForm Noncommercial 1.0.0

A multi asset ledger and a paper trading exchange built on it, as one public API. Built in two milestones. The ledger ships first and stands on its own. The exchange is built on top of it and cannot create or destroy money, which the ledger proves after every trade.

---

## 1. What this is and why

Plutus exists to show backend rigor in public. Every other project in the author's portfolio is closed source. This one is the place a reviewer can open the code, run the tests, read the commits and call the live API.

The product is a service any developer can use in thirty seconds: mint a key, create a ledger, move money between accounts, hold funds, receive signed webhooks, and verify the books from a public URL. Milestone two adds an exchange where the author's own trading systems, and anyone else's, can paper trade against real reference prices with simulated depth.

The hardest problems in backend engineering are the product here rather than features around it: concurrency, idempotency, money integrity, auditability, and honest operation on serverless infrastructure at zero cost.

## 2. Locked decisions

Settled with the owner. Not open for relitigation during implementation.

| Decision | Value |
|---|---|
| Name | Plutus |
| Repository | Public. PolyForm Noncommercial 1.0.0. Read, run, learn; no commercial use without permission |
| Runtime | Node 22, TypeScript strict, ES modules |
| Framework | Express 5, exported as one Vercel Function |
| Hosting | Vercel Hobby, region `iad1`. Cost: zero |
| Database | Neon Postgres, free plan, region `us-east-1`. Plain SQL through `pg`. No ORM |
| Hot state | Upstash Redis, free plan. Rate limits and short caches only. Never the source of truth |
| Background work | Upstash QStash for webhook delivery: a delayed HTTPS message per attempt, 1,000 messages a day free, signed callbacks. One daily Vercel cron for sweeps. Vercel Workflows were the first choice and were dropped on 2026-09-04 because they require the Express app to be rebuilt through Nitro, which breaks the plain Express deployment this project exists to show |
| Validation and docs | Every request and response schema is a zod schema. OpenAPI 3.1 is generated from those schemas. Scalar renders it at `/docs` |
| Money | Integer minor units, `BIGINT` in Postgres, strings in JSON. Never a float, never a JSON number |
| Identity | API keys only. No accounts, no email, no personal data stored anywhere |
| Milestones | One: the ledger, shipped and on the portfolio with its own README before any exchange code. Two: the exchange |
| Git identity | Every commit by the owner under his own name and address. No assistant trailer, ever |

## 3. Milestones and acceptance

### Milestone one, the ledger

Done when all of the following are true on the deployed URL, not on a laptop:

1. A stranger can mint a sandbox key, create a ledger, fund an account from the world, transfer between accounts, hold and capture, and read the journal, using only the curl block in the README.
2. `GET /v1/ledgers/{id}/verify` returns a pass on a ledger with at least one thousand journal entries, and returns a fail naming the first broken sequence when one entry is tampered in a test database.
3. A registered webhook receives a signed delivery, the README's verifier accepts it, and a deliberately failing endpoint reaches the dead letter list and can be retried by hand.
4. The concurrency test fires fifty parallel transfers against one account with enough money for twenty, exactly twenty post, the balance never goes below zero, and the journal has no gaps.
5. CI on GitHub Actions is green on main: lint, typecheck, house rules, unit, integration against real Postgres, property tests, contract tests.
6. The README, the landing page at `/`, and the Scalar reference at `/docs` are live, and the portfolio links to the landing page.

### Milestone two, the exchange

Done when:

1. A key can faucet a wallet, place limit and market orders on BTC-USDT and ETH-USDT, get filled against the house ladder and against other traders, cancel, and read balances, orders and trades.
2. After a randomised trading session of at least one thousand orders from several keys, the exchange ledger's verify endpoint passes and every asset sums to zero.
3. Signed requests are accepted and unsigned, expired, or tampered ones are refused with the named codes.
4. A WebSocket client receives book deltas and trades, is disconnected at the five minute limit, reconnects with its last sequence number, and misses nothing.
5. The author's own trading system places at least one order through the signed API from outside the repo.

## 4. Architecture

One Express application, one Vercel Function, one Postgres database, one Redis.

```
client --HTTP--> Vercel Function (Express 5)
                    |  auth, rate limit, idempotency, validation
                    +--> Neon Postgres   (ledgers, journal, orders, deliveries)
                    +--> Upstash Redis   (rate limit windows, reference price cache)
                    +--> Upstash QStash   (delayed callbacks that drive webhook retries)
Vercel cron (daily) --> /internal/sweep   (expired holds, idle cleanup, house refill)
```

Rules that follow from serverless:

- No state lives in process memory between requests. Anything durable is in Postgres. Anything hot and disposable is in Redis.
- Every write that must be atomic runs inside one Postgres function under row locks. The application never does read then write on money.
- There are no loops. Anything that looks like a loop is either a delayed message that calls back into the API, or work done on demand inside a request.
- A function invocation lives at most 300 seconds. WebSocket connections are designed around that limit, not against it.

Layers inside `src`:

| Directory | Holds | Depends on |
|---|---|---|
| `src/domain` | Pure rules: amounts, fees, matching arithmetic, hashing, canonical JSON. No I/O | nothing |
| `src/db` | Connection, migrations runner, typed query functions, SQL functions | `pg` |
| `src/platform` | Auth, rate limiting, idempotency, webhooks, logging, errors, request ids | `src/db`, Redis |
| `src/routes` | The HTTP surface. Thin: validate, call, respond | everything above |
| `src/schemas` | zod schemas and the OpenAPI document built from them | nothing |
| `api/index.ts` | The Vercel entry that exports the Express app | `src` |

## 5. The ledger domain

### 5.1 Identifiers

Every entity has a prefixed id generated in the application from 16 random bytes encoded in base62: `ldg_`, `acct_`, `tr_`, `hold_`, `whe_` for webhook endpoints, `whd_` for deliveries, `evt_` for events, `key_` for key ids, `ord_`, `trd_`. Ids are stored as `text` primary keys. They are never sequential and never guessable.

### 5.2 Assets

Fixed set, seeded by migration. Keys cannot create assets.

| Code | Name | Exponent | Kind |
|---|---|---|---|
| GHS | Ghana cedi | 2 | fiat |
| HKD | Hong Kong dollar | 2 | fiat |
| USD | US dollar | 2 | fiat |
| USDT | Tether | 6 | crypto |
| BTC | Bitcoin | 8 | crypto |
| ETH | Ether | 8 | crypto |

An amount of an asset is always an integer count of minor units. 1 BTC is `"100000000"`. 12.50 GHS is `"1250"`. The API accepts and returns amounts as decimal strings of minor units. A JSON number in an amount field is a validation error.

### 5.3 Keys

| Column | Notes |
|---|---|
| `id` | `key_` id, safe to send in headers and logs |
| `secret_hash` | SHA256 of the secret. The secret itself is never stored |
| `prefix`, `last4` | `pl_test` or `pl_live`, and the last four characters, for display |
| `mode` | `test` or `live` |
| `scopes` | array of `ledger:read`, `ledger:write`, `webhooks:manage`, `exchange:trade` |
| `created_at`, `last_used_at` | `last_used_at` updated at most once a minute |
| `rotated_to` | id of the replacement key after rotation, or null |
| `expires_at` | null, or fifteen minutes after rotation for the old key |
| `revoked_at` | null or the moment of revocation |

The secret is `pl_test_` or `pl_live_` followed by 32 random bytes in base62, shown exactly once in the minting response. Sandbox keys carry all four scopes. Live keys are created by `npm run key:live`, a script run on the owner's machine against the database, never by the API. Comparison of a presented secret against a hash is constant time.

### 5.4 Ledgers

| Column | Notes |
|---|---|
| `id` | `ldg_` id |
| `key_id` | owner |
| `name` | 1 to 80 characters |
| `next_seq` | the next journal sequence number, starts at 1 |
| `head_hash` | hash of the latest journal entry, 32 zero bytes at creation |
| `last_activity_at` | updated on every write |
| `created_at` | |

The ledger row is locked `FOR UPDATE` at the start of every write to the ledger. That serialises writes per ledger, which is what makes the journal sequence gapless and the chain consistent. Different ledgers never block each other.

The exchange lives in one system ledger with the fixed id `ldg_exchange`, owned by the house key, created by migration.

### 5.5 Accounts

| Column | Notes |
|---|---|
| `id` | `acct_` id |
| `ledger_id` | |
| `asset` | one asset code, fixed at creation |
| `name` | 1 to 80 characters |
| `kind` | `normal` or `world` |
| `balance` | `BIGINT`, minor units |
| `held` | `BIGINT`, minor units, the sum of open holds |
| `metadata` | jsonb, at most 20 keys, string values at most 500 characters |
| `created_at` | |

Available is `balance - held` and is derived, never stored. Constraints enforced in Postgres: `held >= 0`; for `normal` accounts `balance - held >= 0`; a `world` account may be negative.

Every ledger has one world account per asset, created lazily the first time that asset is used in the ledger, addressed in the API as `world:USDT`, `world:BTC` and so on rather than by id. Money enters a ledger as a transfer from a world account and leaves as a transfer to one. The world is the outside, and its negative balance is exactly the money in circulation inside the ledger.

### 5.6 Transfers and legs

A transfer is one or more legs applied atomically.

| Table | Columns |
|---|---|
| `transfers` | `id`, `ledger_id`, `seq` (the journal sequence it was posted at), `memo` (0 to 200 chars), `metadata`, `created_at` |
| `transfer_legs` | `transfer_id`, `position`, `from_account`, `from_hold` (nullable), `to_account`, `asset`, `amount` |

Rules:

- 1 to 20 legs. Each amount is a positive integer. Each leg's accounts must belong to this ledger and both must hold the leg's asset. `from` and `to` differ.
- A leg draws either from an account's available funds (`from`), or from an open hold on that account (`from_hold`). Drawing from a hold reduces the hold's remaining amount, the account's `held`, and the account's `balance` together, so held money moves without ever becoming available first.
- Posting runs inside the Postgres function `post_transfer(ledger_id, key_id, legs jsonb, memo, metadata)`: lock the ledger row, lock every touched account `FOR UPDATE` in ascending id order, check every leg's source has enough available or enough remaining on the hold, apply all legs, append one journal entry, return the transfer. Any failure rolls back the whole transfer with `insufficient_funds` naming the first leg that failed.
- A transfer is immutable once posted. There is no reversal endpoint. Undoing money is a new transfer in the opposite direction, which keeps the journal honest.

### 5.7 Holds

| Column | Notes |
|---|---|
| `id` | `hold_` id |
| `ledger_id`, `account_id`, `asset` | |
| `amount` | original amount |
| `remaining` | what is still held |
| `status` | `open`, `captured`, `released`, `expired` |
| `expires_at` | default 15 minutes from creation, maximum 7 days |
| `memo`, `metadata`, `created_at`, `closed_at` | |

Creating a hold requires `available >= amount` and increases `held`. Capture is a transfer with a `from_hold` leg, exposed as a convenience endpoint that takes a destination account and an amount up to `remaining`; with `release_remainder: true` the rest is released and the hold closes as `captured`, otherwise the rest stays held and the hold stays `open`. Release returns `remaining` to available and closes the hold. Expiry is handled lazily: any read of an account or hold first closes that account's expired holds; the daily sweep closes the rest. Every hold transition appends a journal entry.

### 5.8 The journal and the chain

| Column | Notes |
|---|---|
| `ledger_id`, `seq` | primary key, gapless per ledger |
| `kind` | `transfer.posted`, `hold.created`, `hold.captured`, `hold.released`, `hold.expired` |
| `entity_id` | the transfer or hold |
| `payload` | jsonb, the canonical record of what happened, including every leg and amount |
| `prev_hash` | 32 bytes, the previous entry's hash, or 32 zero bytes for `seq` 1 |
| `hash` | SHA256 of `prev_hash` concatenated with the canonical bytes of `payload` |
| `created_at` | |

Canonical bytes are the payload serialised as JSON with keys sorted recursively, no whitespace, amounts as strings, timestamps as ISO 8601 in UTC with milliseconds. The same function in `src/domain/canonical.ts` is used to write and to verify, and it has its own tests against fixed vectors.

`GET /v1/ledgers/{id}/verify` streams every entry in sequence order and:

1. recomputes each hash from `prev_hash` and `payload` and compares it;
2. checks each `prev_hash` equals the previous entry's `hash`;
3. checks the sequence is gapless from 1 to `next_seq - 1`;
4. replays every payload into an in memory table of balance and held per account and compares it with the stored values of every account;
5. sums balances per asset, world included, and checks each sum is zero.

It returns `{ ok, entries_checked, first_bad_seq, replay_matches, assets: [{ asset, sum }] }` and a 200 either way, because a failing verification is a successful answer. It is rate limited hard because it reads the whole ledger, and its result is cached in Redis for 60 seconds keyed by ledger and `next_seq`, so repeated calls with no new writes cost nothing.

### 5.9 Events

Every journal entry also produces an event row: `events(id, key_id, ledger_id, type, payload, created_at)`, where `type` is the journal kind. Events are what webhooks deliver. They are retained for 30 days.

## 6. Invariants

These hold at all times, are enforced in Postgres, and are asserted by the property test suite after every generated operation.

1. For every asset in every ledger, the sum of `balance` over all accounts including world accounts is zero.
2. For every normal account, `balance - held >= 0` and `held >= 0`.
3. For every account, `held` equals the sum of `remaining` over its open holds.
4. The journal for a ledger is gapless from 1 and every hash verifies.
5. Replaying the journal from an empty state reproduces every stored balance and held amount exactly.
6. No amount anywhere is ever a floating point number.

## 7. API conventions

- Base path `/v1`. Breaking changes get `/v2`; nothing is versioned by header.
- JSON in, JSON out. Request bodies must carry `Content-Type: application/json` and are capped at 64 KB. Anything else is a 415 or 413.
- Amounts are decimal strings of minor units. Timestamps are ISO 8601 UTC with milliseconds. Ids are the prefixed strings above.
- Authentication for ledger endpoints: `Authorization: Bearer pl_test_...`. A missing or unknown key is a 401. A key without the needed scope is a 403 with `forbidden_scope`.
- Every response carries `X-Request-Id`, echoed from the request if the client sent one, otherwise generated.
- Errors are RFC 9457 problem details, `application/problem+json`: `{ type, title, status, detail, code, request_id, errors? }`, where `errors` is a list of `{ path, message }` on validation failures. `code` is a stable machine string. No stack trace, no SQL, no internal path ever appears in a response.
- Stable codes: `validation_failed`, `unauthorized`, `forbidden_scope`, `not_found`, `insufficient_funds`, `asset_mismatch`, `hold_not_open`, `idempotency_key_reused`, `idempotency_in_flight`, `rate_limited`, `sandbox_limit_reached`, `rate_limiter_unavailable`, `invalid_signature`, `timestamp_out_of_window`, `order_rejected`, `internal_error`.
- Lists are cursor paginated: `?limit=` from 1 to 100, default 20, and `?cursor=`. Responses are `{ data: [...], next_cursor: string | null }`. Cursors are opaque base64url strings encoding the sort key and id. Lists are newest first except the journal, which is oldest first by sequence.
- Idempotency: any `POST` may carry `Idempotency-Key`, 1 to 255 characters, scoped to the key. The server stores a SHA256 fingerprint of method, path and body with the eventual response for 24 hours in Postgres. A repeat with the same fingerprint returns the stored status and body with `Idempotent-Replayed: true`. The same key with a different fingerprint is a 409 `idempotency_key_reused`. A repeat while the first is still running is a 409 `idempotency_in_flight`. The README recommends a key on every transfer, capture, release and order.
- CORS is open for all origins with no credentials. Keys are secrets and do not belong in browsers, and the docs say so.

## 8. Ledger API surface

| Method and path | Scope | Purpose |
|---|---|---|
| `POST /v1/keys` | none, IP limited | Mint a sandbox key. Returns `{ id, secret, mode, scopes, created_at }`. The only time the secret is shown |
| `GET /v1/keys/me` | any | The calling key without its secret, plus usage counters |
| `POST /v1/keys/rotate` | any | New secret for the same identity. Old secret valid fifteen more minutes |
| `GET /v1/assets` | none | The asset table |
| `POST /v1/ledgers` | `ledger:write` | `{ name }` |
| `GET /v1/ledgers`, `GET /v1/ledgers/{id}` | `ledger:read` | |
| `POST /v1/ledgers/{id}/accounts` | `ledger:write` | `{ asset, name, metadata? }` |
| `GET /v1/ledgers/{id}/accounts`, `GET .../accounts/{id}` | `ledger:read` | Balance, held, available |
| `POST /v1/ledgers/{id}/transfers` | `ledger:write` | `{ legs: [{ from | from_hold, to, asset, amount }], memo?, metadata? }` |
| `GET /v1/ledgers/{id}/transfers`, `GET .../transfers/{id}` | `ledger:read` | Filter by `account` |
| `POST /v1/ledgers/{id}/holds` | `ledger:write` | `{ account, amount, expires_in_seconds?, memo?, metadata? }` |
| `POST .../holds/{id}/capture` | `ledger:write` | `{ to, amount?, release_remainder? }`. `amount` defaults to `remaining` |
| `POST .../holds/{id}/release` | `ledger:write` | |
| `GET .../holds`, `GET .../holds/{id}` | `ledger:read` | Filter by `account`, `status` |
| `GET /v1/ledgers/{id}/journal` | `ledger:read` | Oldest first, `?since=` sequence |
| `GET /v1/ledgers/{id}/verify` | `ledger:read` | The proof |
| `POST /v1/webhooks` | `webhooks:manage` | `{ url, events }`. Returns the secret once |
| `GET /v1/webhooks`, `GET /v1/webhooks/{id}`, `DELETE /v1/webhooks/{id}` | `webhooks:manage` | |
| `PATCH /v1/webhooks/{id}` | `webhooks:manage` | `{ status?, events?, url? }`. Re enabling a disabled endpoint resets its failure count |
| `GET /v1/webhooks/{id}/deliveries` | `webhooks:manage` | Newest first, with status and response excerpt |
| `POST /v1/webhooks/{id}/deliveries/{id}/retry` | `webhooks:manage` | Manual retry from the dead letter list |
| `GET /v1/events`, `GET /v1/events/{id}` | `ledger:read` | Everything that happened, newest first |
| `GET /health` | none | Dependency checks |
| `GET /openapi.json`, `GET /docs` | none | The contract and its rendering |
| `GET /` | none | The landing page |

## 9. Platform

### 9.1 Rate limits

Sliding window, in Upstash Redis, through `@upstash/ratelimit` behind a small interface with an in memory implementation for tests.

| Subject | Limit |
|---|---|
| Minting keys, per IP | 5 per hour |
| Sandbox key, all endpoints | 60 per minute |
| Live key, all endpoints | 600 per minute |
| Verify, per key | 10 per minute |
| Exchange, per key | 1,200 weight per minute, and 10 order placements per second |

Every response carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`. A refusal is a 429 `rate_limited` with `Retry-After` in seconds. If Redis cannot be reached within 500 ms the request fails closed with a 503 `rate_limiter_unavailable`, and `/health` reports Redis as down.

### 9.2 Sandbox ceilings

| Ceiling | Value |
|---|---|
| Ledgers per key | 10 |
| Accounts per ledger | 50 |
| Journal entries per ledger | 10,000 |
| Webhook endpoints per key | 5 |
| Open holds per account | 100 |
| Request body | 64 KB |
| Metadata | 20 keys, 500 character values |
| Idle sandbox ledger | deleted after 14 days without a write |
| Idle sandbox key | deleted after 30 days without a request, with its ledgers |

A ceiling hit is a 409 `sandbox_limit_reached` with `detail` naming the ceiling. All of them are listed on the docs page under Limits. Ceilings apply to sandbox keys and their ledgers. The exchange ledger and the house key are system owned and exempt.

### 9.3 Webhooks

| Table | Columns |
|---|---|
| `webhook_endpoints` | `id`, `key_id`, `url` (https only), `secret` (random 32 bytes base62, stored so the server can sign), `events` (subscribed types from the journal kinds and the order types in 10.4, or `*`), `status` (`active`, `disabled`), `consecutive_failures`, `created_at` |
| `webhook_deliveries` | `id`, `endpoint_id`, `event_id`, `attempt`, `status` (`pending`, `succeeded`, `failed`, `dead`), `response_status`, `response_excerpt` (first 1,024 bytes), `next_attempt_at`, `delivered_at`, `created_at` |

Delivery is an HTTPS `POST` with the event as the body and two headers: `Plutus-Event-Id` and `Plutus-Signature: t=<unix seconds>,v1=<hex>`, where the hex is HMAC SHA256 with the endpoint secret over `t + "." + body`. A receiver recomputes it, compares in constant time, and rejects any `t` more than five minutes from now. The README ships a twelve line verifier in Node.

Delivery is driven by QStash. When an event is written, the API creates one delivery row per subscribed endpoint and publishes a QStash message addressed to `POST /internal/webhooks/deliver` carrying the delivery id. QStash calls back, the API verifies the QStash signature, makes one attempt, and records the result. On failure the API publishes the next message with a delay. Schedule of attempts: immediate, then delays of 30 seconds, 2 minutes, 10 minutes, 30 minutes, 1 hour, 3 hours, 6 hours, 12 hours; eight attempts in roughly 23 hours. A 2xx within 10 seconds is success. Anything else is a failure. After the eighth failure the delivery is `dead` and appears in the dead letter list, where `retry` publishes a fresh message for it. Fifty consecutive failures across deliveries disable the endpoint; the key's next request carries a `Plutus-Warning` header naming it, and re enabling is a `PATCH` with `status: active`.

Without a QStash token, locally and in tests, the scheduler is an in process double that either delivers at once or records what it would have scheduled, so every delivery path is testable without the network. The daily sweep republishes any delivery left `pending` for more than an hour, so a lost message costs a delay, never a delivery. QStash free is 1,000 messages a day; each attempt is one message, and `/health` reports the day's count.

### 9.4 Observability

- pino JSON logs. Every line carries `request_id`, `key_id` when known, route, status, and latency in milliseconds. Never a secret, never a full request body, never a signature.
- `X-Request-Id` on every response and in every error body.
- `GET /health` runs `SELECT 1` against Postgres and a `PING` against Redis, each with a 500 ms timeout, and returns `{ status: "ok" | "degraded", checks: { postgres: { ok, latency_ms }, redis: { ok, latency_ms } }, version }` with 200 or 503.
- Sentry on the free plan for unhandled errors, with `beforeSend` scrubbing headers and bodies.

### 9.5 Security

- Helmet with a strict header set. `Content-Type` enforced. Body size capped at 64 KB. JSON parse errors are a 400 `validation_failed`, never a stack.
- Constant time comparison for every secret, key hash and signature.
- Secrets live only in Vercel environment variables. `.env.example` lists every variable with a fake value. The house rules check fails the build if a real looking secret appears in the tree.
- Nothing in the system identifies a person. Keys are random. Webhook URLs are the only user supplied strings that leave the system, and they must be https.
- Every privilege claim in this document is probed in a test with the real behaviour, not read from the code: a key without a scope, an expired rotated key, a tampered signature, a replayed idempotency key with a different body, a hold captured twice.

### 9.6 Configuration

| Variable | Use |
|---|---|
| `DATABASE_URL` | Neon pooled connection for the API |
| `DATABASE_URL_UNPOOLED` | Neon direct connection for migrations |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Rate limits and caches |
| `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` | Publishing delayed deliveries and verifying the callbacks |
| `PUBLIC_BASE_URL` | The deployment's own https origin, which QStash calls back to |
| `CRON_SECRET` | Vercel sends it as a bearer to `/internal/sweep`; the route refuses anything else |
| `SENTRY_DSN` | Optional |
| `REFERENCE_PRICE_URL` | Defaults to Binance's public ticker endpoint |
| `PLUTUS_VERSION` | Set from the git SHA at build time, shown in `/health` |

## 10. The exchange domain, milestone two

### 10.1 Markets

| Column | Notes |
|---|---|
| `symbol` | `BTC-USDT`, `ETH-USDT`. Primary key |
| `base`, `quote` | asset codes |
| `tick_size` | minimum price step, in quote minor units |
| `lot_size` | minimum quantity step, in base minor units |
| `min_notional` | minimum order value, in quote minor units |
| `maker_fee_bps`, `taker_fee_bps` | basis points, seeded 10 and 10 |
| `status` | `open` or `halted` |
| `house_quoted_at` | when the house ladder was last refreshed |
| `reference_price` | last known reference, quote minor units per whole base unit, or null |
| `next_seq` | the next market event sequence number |

A price is quote minor units per one whole unit of base. Notional is `price * quantity / 10^base_exponent`. A check constraint requires `tick_size * lot_size` to be a multiple of `10^base_exponent`, so every notional is an exact integer and no rounding exists anywhere in matching.

| Symbol | Tick | Lot | Min notional |
|---|---|---|---|
| BTC-USDT | 10,000 (0.01 USDT) | 100,000 (0.001 BTC) | 5,000,000 (5 USDT) |
| ETH-USDT | 10,000 (0.01 USDT) | 1,000,000 (0.01 ETH) | 5,000,000 (5 USDT) |

Fees are charged in the quote asset on both sides: the buyer pays notional plus fee, the seller receives notional minus fee. A fee is `ceil(notional * bps / 10000)`, charged on the order's cumulative filled notional rather than on each fill in isolation, so per fill rounding across a partially filled order never sums to more than the fee its hold reserved. Fees are transferred to the house fee account in the same transfer as the fill.

### 10.2 Wallets

The exchange is the system ledger `ldg_exchange`. A trading key gets one account per asset in it, created on first faucet, named after the key. `GET /v1/exchange/balances` lists them with balance, held and available.

`POST /v1/exchange/faucet` funds the caller from the world with 100,000 USDT, 1 BTC and 10 ETH, once per 24 hours per key. `POST /v1/exchange/reset` cancels every open order, releases every hold, and moves balances back to the faucet amounts through transfers to and from the world. Both are sandbox only.

The house is a key created by migration with accounts funded from the world: 10,000 BTC, 100,000 ETH and 1,000,000,000 USDT, plus a fee account per quote asset. The daily sweep tops any house account below a quarter of its seed back up from the world. Conservation holds because the world goes negative by exactly that amount.

### 10.3 Orders

| Column | Notes |
|---|---|
| `id` | `ord_` id |
| `key_id`, `market` | |
| `client_order_id` | optional, unique per key, the idempotency handle bots already use |
| `side` | `buy` or `sell` |
| `type` | `limit` or `market` |
| `time_in_force` | `GTC`, `IOC`, `FOK`. Market orders are always `IOC` |
| `post_only` | boolean, limit only |
| `price` | required for limit, null for market, multiple of tick |
| `quantity` | base minor units, multiple of lot; required for limit and market sell |
| `quote_amount` | quote minor units; required for market buy instead of `quantity` |
| `filled_quantity`, `filled_quote` | running totals |
| `status` | `open`, `partially_filled`, `filled`, `cancelled`, `rejected` |
| `hold_id` | the margin hold |
| `accepted_seq` | market event sequence at acceptance |
| `reject_reason` | null or a stable string |
| `created_at`, `updated_at` | |

Margin: a limit buy holds `notional + fee` in quote. A limit sell holds `quantity` in base. A market buy holds `quote_amount`. A market sell holds `quantity`. Fills draw from the hold with `from_hold` legs. When an order leaves the book, its hold closes: captured when fills were drawn from it, released when nothing was, and whatever remained goes back to the account either way.

Rejections, all with `order_rejected` and a named reason: `market_halted`, `price_not_tick`, `quantity_not_lot`, `below_min_notional`, `insufficient_funds`, `post_only_would_take`, `fok_not_fillable`, `duplicate_client_order_id`, `self_trade`, `notional_too_large` (task 6 amendment: `price * quantity` is computed in `numeric` before the divide precisely so this can be caught and named instead of a raw bigint overflow; raised when the result still will not fit back into a `bigint`).

### 10.4 Matching

`place_order(...)` is one Postgres function:

1. `pg_advisory_xact_lock` on the market. Matching for a market is serialised.
2. If the house ladder is stale, refresh it (10.5), inside the same lock.
3. Validate the order and create its hold through the ledger. A failed hold is a rejection.
4. Walk the opposite side of the book in price time priority while the incoming order can still trade. For each resting order, fill `min(remaining, resting remaining)` at the resting price, record a trade, and post one ledger transfer with three legs: quote from the buyer's hold to the seller's account for `notional - seller_fee`; quote from the buyer's hold to the fee account for `seller_fee + buyer_fee`; base from the seller's hold to the buyer's account for the filled quantity. The buyer's hold covered `notional + buyer_fee`, so it holds exactly enough. For a market buy, the fillable quantity at each level is the largest multiple of the lot size whose notional plus buyer fee fits in the remaining quote.
5. `post_only` that would fill on step 4 is rejected before any fill. `FOK` that cannot fill in full is rejected before any fill; the walk is a dry run first. `IOC` fills what it can and cancels the rest. `GTC` rests on the book with its remaining hold.
6. Every accept, fill, cancel and rejection is a row in `market_events(market, seq, type, payload, created_at)` with a per market gapless sequence. The same transitions are written as events for the trading key, typed `order.accepted`, `order.filled`, `order.cancelled` and `order.rejected`, so a trader's webhooks receive them like any ledger event.
7. Lock order is fixed everywhere and never varies: market advisory locks in symbol order, then the ledger row, then accounts in ascending id order. Reset, which touches every market, takes the market locks first for the same reason. This is what makes deadlock impossible rather than unlikely.

Throughput is tens of orders per second per market, which is the honest number for matching inside Postgres, and it is the right trade for durability at zero cost. The docs say so.

### 10.5 The house market maker

There is no loop. The house quotes when someone is looking.

On any book, ticker, trades or candles read, and on any order placement, if `house_quoted_at` is older than 15 seconds, the request first refreshes the house ladder under the market lock: fetch the reference price (Redis cached for 10 seconds; on a fetch failure keep the stored `reference_price`; if none exists, skip quoting), cancel every open house order, and place five bids and five asks. Level `i` from 0 to 4 sits at the reference minus `(10 + 5 i)` basis points for bids and plus the same for asks, rounded to the tick, with quantity `base_size * 2^i` where `base_size` is 0.05 BTC or 1 ETH. Then the request proceeds. The daily sweep refreshes cold markets too.

Fills against the house are real fills through the ledger. Anyone polling every few seconds keeps the book alive, and prices track the real market with simulated depth. The docs describe this plainly under How the market maker works.

### 10.6 Market data

| Endpoint | Returns |
|---|---|
| `GET /v1/exchange/markets` | the markets table |
| `GET /v1/exchange/markets/{symbol}/book?depth=` | bids and asks aggregated by price, depth 1 to 100, with `seq` |
| `GET /v1/exchange/markets/{symbol}/trades?limit=` | recent trades, newest first |
| `GET /v1/exchange/markets/{symbol}/ticker` | last price, 24 hour high, low, base volume, quote volume, `seq` |
| `GET /v1/exchange/markets/{symbol}/candles?interval=1m|5m|1h&limit=` | open, high, low, close, volume, aggregated in SQL from trades |

Public, no key needed, cached in Redis for 2 seconds.

`GET /v1/exchange/verify` is public too, no key needed, limited to 2 calls a minute per IP: it runs the ledger verification of `ldg_exchange` and returns the same document as section 5.8. This is the proof that the exchange cannot create or destroy money, and it is the URL the milestone two README points at.

### 10.7 WebSocket

A spike at the start of the milestone two plan confirms that a WebSocket upgrade reaches an Express app deployed as a Vercel Function, on this account, before anything is built on it. If it does not hold, the stream ships as Server Sent Events with the identical message and sequence contract, and the docs say which one it is.

`GET /v1/exchange/stream` upgrades. The client sends `{ "op": "subscribe", "channels": ["book:BTC-USDT", "trades:BTC-USDT"], "since": <seq> }`. The server replays every market event after `since` for those channels, then tails `market_events` once a second and pushes `{ channel, seq, data }` messages, with a heartbeat every 15 seconds. At four minutes fifty seconds the server closes with code 4000 and reason `reconnect`. The client reconnects with the last `seq` it saw and misses nothing, because sequence numbers are gapless. Public channels only. No authentication crosses a socket.

### 10.8 Signing

Trading endpoints require signed requests, not a bearer token.

| Header | Value |
|---|---|
| `X-Plutus-Key-Id` | the `key_` id |
| `X-Plutus-Timestamp` | Unix milliseconds |
| `X-Plutus-Recv-Window` | optional, milliseconds, default 5,000, maximum 60,000 |
| `X-Plutus-Signature` | hex HMAC SHA256 with the key secret over `timestamp + "\n" + METHOD + "\n" + path + "\n" + body` |

The server refuses a timestamp outside the window with `timestamp_out_of_window` and a mismatch with `invalid_signature`, both 401. The secret never travels. Replays inside the window are made harmless by `client_order_id` on orders and `Idempotency-Key` on everything else; placing an order requires one of the two, refused with `validation_failed` (422) naming both when neither is sent.

### 10.9 Endpoint weights

| Endpoint | Weight |
|---|---|
| place order, cancel | 1, plus the 10 per second cap on placements |
| balances, open orders | 5 |
| book, trades, ticker | 5 |
| candles | 10 |
| order history, my trades | 10 |

1,200 weight per minute per key, returned in the same `RateLimit` headers.

### 10.10 Exchange API surface

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /v1/exchange/markets` and the market data endpoints in 10.6 | none | |
| `GET /v1/exchange/verify` | none, IP limited | the proof for the exchange ledger |
| `POST /v1/exchange/faucet` | signed, `exchange:trade` | fund the wallet |
| `POST /v1/exchange/reset` | signed | wipe orders and refund |
| `GET /v1/exchange/balances` | signed | |
| `POST /v1/exchange/orders` | signed | place |
| `DELETE /v1/exchange/orders/{id}` | signed | cancel one, by id or `client_order_id` |
| `DELETE /v1/exchange/orders?market=` | signed | cancel all, optionally per market |
| `GET /v1/exchange/orders?status=open` | signed | open orders, and history with other statuses |
| `GET /v1/exchange/orders/{id}` | signed | |
| `GET /v1/exchange/trades` | signed | my trades |
| `GET /v1/exchange/stream` | none | WebSocket |

## 11. Storage and migrations

Plain SQL files in `db/migrations`, numbered `0001_` upward, applied by `npm run migrate` through `DATABASE_URL_UNPOOLED`, recorded in a `schema_migrations` table. Migrations run from CI on main after the test suites pass, never at cold start. Every Postgres function has its own file and its own tests. The seed of assets, the exchange ledger, the house key and the markets is a migration, so a fresh database is complete after `migrate`.

Indexes worth naming now: `journal (ledger_id, seq)`, `transfer_legs (from_account)`, `transfer_legs (to_account)`, `holds (account_id) where status = 'open'`, `orders (market, side, price, created_at) where status in ('open', 'partially_filled')`, `market_events (market, seq)`, `idempotency_keys (key_id, idem_key)`, `webhook_deliveries (status, next_attempt_at)`.

## 12. Testing

| Suite | What it proves | Against |
|---|---|---|
| Unit, Vitest | Pure rules: amounts, fees, canonical JSON, hashing vectors, validators, cursor encoding | nothing |
| Integration, Vitest | Every endpoint, every Postgres function, every error code | a real Postgres: Docker locally, a service container in CI |
| Property, fast-check | Thousands of random sequences of transfers, holds, captures and releases, then all six invariants and a full verify | real Postgres |
| Concurrency | Fifty parallel transfers with money for twenty; parallel captures of one hold; parallel orders on one market. Exactly the right number succeed, no negative balance, no sequence gap | real Postgres |
| Mutation | The row lock replaced with read then write, the signature check disabled, the idempotency fingerprint ignored: each must make its test go red | real Postgres |
| Contract | Every recorded response validates against the generated OpenAPI document | the app |
| House rules | `scripts/check-house-rules.mjs`: no `console.log` in `src`, no `parseFloat`, `toFixed` or arithmetic on `number` in `src/domain/money.ts` consumers, no `any`, no secret shaped string in the tree, lockfile present | the tree |

The rate limiter and the reference price client sit behind interfaces with in memory test doubles; one smoke test each runs against the real Upstash and the real ticker when their variables are present and is skipped otherwise, and the skip is printed, never silent.

CI is GitHub Actions on every push and pull request: install, lint, typecheck, house rules, unit, integration and property suites with a `postgres:16` service container, contract tests, then on main only, `migrate` against Neon and a Vercel production deploy. The badge is the first line of the README after the title.

## 13. Deployment and operations

- `api/index.ts` exports the Express app. `vercel.json` rewrites every path to it, sets region `iad1`, sets `maxDuration` 300 on the function because the stream needs it, and declares one cron: `0 3 * * *` to `/internal/sweep`. Every route other than the stream aborts its own work at 30 seconds with a 503, so a slow database cannot hold a function open for five minutes.
- The sweep, guarded by `CRON_SECRET`: close expired holds, delete idle sandbox ledgers and keys, delete events older than 30 days and idempotency records older than 24 hours, republish webhook deliveries left pending for over an hour, refresh cold house ladders, refill house accounts.
- Integration tests run against a real Postgres started in process by `embedded-postgres` on the developer's machine, because this machine has no Docker, and against a `postgres:18` service container in CI. `TEST_DATABASE_URL`, when set, overrides both.
- Neon and Vercel are both in US east so the database sits beside the functions. Cold starts on Neon's free plan resume on the first connection, and `/health` reports the latency honestly.
- Rollback is a Vercel redeploy of the previous build. Migrations are additive; a migration that drops or renames a column ships one release after the code stopped using it.

## 14. Documents this project produces

- `README.md`: what it is, the badge, a thirty second quickstart in curl, the verify URL, how webhooks are signed with the verifier, limits, the licence line.
- `docs/superpowers/specs/2026-09-04-plutus-design.md`: this file.
- `docs/superpowers/plans/`: one implementation plan per milestone.
- `docs/how-it-works.md`: written at the end, in plain words, for the owner: what each part does, why it is built that way, and what the project taught. Not marketing. Not for recruiters. For him.
- The landing page at `/`: the story in a few paragraphs, the curl block, links to the docs and the repo.

## 15. Non goals

- No real money, no fiat rails, no KYC, no custody.
- No customer accounts, passwords, OAuth or sessions.
- No cross ledger transfers. A ledger is a closed system by design.
- No transfer reversal endpoint. Undo is a new transfer.
- No custom assets from the API.
- No order modification. Cancel and replace.
- No margin, futures, leverage or short selling.
- No multi region, no read replicas.
- No GraphQL, no gRPC, no SDKs. The OpenAPI document is the SDK.
- No frontend beyond the landing page and the rendered reference.
