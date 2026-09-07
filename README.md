# Plutus

A ledger you can audit and an exchange you can trade against.

![ci](https://github.com/atilladev-owner/Plutus/actions/workflows/ci.yml/badge.svg)

## What it is

Plutus is a multi asset ledger, and from milestone two a paper trading exchange, exposed as a single HTTP API. Every account is double entry, every transfer runs as one Postgres function under row locks, and every write appends to a hash chained journal anyone can verify. Idempotency keys make a retried write safe, and webhook deliveries are signed and retried on a fixed schedule. The whole surface is asserted by a test suite of 233 tests across 48 files, run against a real Postgres, not a mock.

## Thirty seconds

```bash
# 1. a key, no signup
curl -s -X POST https://plutus-ten-eta.vercel.app/v1/keys
# 2. a ledger and two accounts
curl -s -X POST https://plutus-ten-eta.vercel.app/v1/ledgers -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"name":"shop"}'
curl -s -X POST https://plutus-ten-eta.vercel.app/v1/ledgers/$LEDGER/accounts -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"asset":"GHS","name":"till"}'
# 3. money in from the world, then between accounts
curl -s -X POST https://plutus-ten-eta.vercel.app/v1/ledgers/$LEDGER/transfers -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Idempotency-Key: fund-1" -d '{"legs":[{"from":"world:GHS","to":"'$TILL'","asset":"GHS","amount":"125000"}]}'
# 4. prove the books
curl -s https://plutus-ten-eta.vercel.app/v1/ledgers/$LEDGER/verify -H "Authorization: Bearer $KEY"
```

## What a stranger can verify

- The verify endpoint, `GET /v1/ledgers/{id}/verify`, recomputes the whole hash chain from the first entry and proves every asset still sums to zero.
- The concurrency test, `tests/integration/concurrency.test.ts`, races fifty parallel transfers against money for twenty and asserts exactly twenty post, no gap, and no balance ever goes negative.
- The mutation script, `scripts/mutate.mjs` (run with `npm run test:mutation`), breaks three of the ledger's SQL invariants on purpose, one at a time, and asserts the suite goes red for each.
- The CI run, linked from the badge above, runs the full suite against a real Postgres service container on every push.

## How webhooks are signed

Every delivery carries two headers: `Plutus-Event-Id` and `Plutus-Signature: t=<unix seconds>,v1=<hex>`, where the hex is HMAC SHA256 over `t + "." + body` using the endpoint's own secret. A receiver recomputes it, compares in constant time, and rejects any `t` more than five minutes from now. `docs/verify-webhook.mjs` is a twelve line verifier in Node that does exactly that.

## Exchange

Milestone two adds a paper trading exchange, built entirely on the ledger above. Two markets, `BTC-USDT` and `ETH-USDT`. Orders match inside a Postgres function under row locks, the same discipline every transfer already uses, so a fill is a ledger transfer with three legs, not a separate system that has to agree with the ledger afterward.

**The faucet.** A sandbox key calls `POST /v1/exchange/faucet` and receives 100,000 USDT, 1 BTC and 10 ETH, funded from the world exactly the way a transfer funds any account. Once per 24 hours per key; a second call inside the window answers 429 with a `Retry-After`. `POST /v1/exchange/reset` cancels every open order, releases every hold, and nets every balance back to those faucet amounts, for starting over without a new key.

**A signed call, in full.** Trading endpoints sign every request instead of sending a bearer token. Four headers travel with the request: `X-Plutus-Key-Id`, `X-Plutus-Timestamp` in Unix milliseconds, `X-Plutus-Recv-Window` (optional, default 5000ms), and `X-Plutus-Signature`, a hex HMAC SHA256 over `timestamp + "\n" + METHOD + "\n" + path + "\n" + body`, keyed by the SHA-256 digest of the key secret rather than the secret itself, since that digest is all the server ever stores. Worked example below: a real key id and secret invented for this README, a fixed timestamp, and the signature `signRequest` (`src/platform/signing.ts`) actually produces for them, so every value here can be recomputed and checked.

```bash
BODY='{"market":"BTC-USDT","side":"buy","type":"limit","price":"6000000000","quantity":"100000"}'
curl -s -X POST https://plutus-ten-eta.vercel.app/v1/exchange/orders \
  -H "Content-Type: application/json" \
  -H "X-Plutus-Key-Id: key_4f9a2c7e1b3d4a5f8e6c9b0a1d2e3f4a" \
  -H "X-Plutus-Timestamp: 1767225600000" \
  -H "X-Plutus-Recv-Window: 5000" \
  -H "X-Plutus-Signature: 16b66c8f8680c4b9c8208e70f9abafa7821eeb9eafa3dba686fe0b4f9a0dbbbc" \
  -d "$BODY"
```

`docs/place-order.mjs` reimplements the same scheme with nothing but `node:crypto`, reads `PLUTUS_KEY_ID` and `PLUTUS_SECRET` from the environment, and places one real order against the live host from any machine outside this repository.

**Verify it.** `GET /v1/exchange/verify` takes no key and recomputes the exchange ledger's own hash chain, the same proof `GET /v1/ledgers/{id}/verify` gives a ledger owner, so a stranger can confirm the exchange has never created or destroyed money without ever holding a key.

**The house, plainly.** There is no background loop pretending to be a market. The house is an ordinary key with ordinary balances. When a request looks at a market, a book read, a ticker, a trade list, or an order placement, and that market's quotes are more than 15 seconds old, the house first cancels its own resting orders and places five fresh bids and five fresh asks around the current Coinbase spot price, from 10 to 30 basis points out on each side, before the request that triggered the refresh continues. A fill against the house is a real fill through the same ledger function every other fill uses. Nobody's money moves because a robot decided to trade; it moves because a real request found a stale ladder and asked for a fresh one.

**Throughput, honestly.** Matching runs inside one Postgres function under an advisory lock per market, which serialises every order on that market against every other. That is tens of orders per second per market, not thousands. It is the right trade for a system whose real claim is that the books never lie, not that it is fast.

**The stream.** `GET /v1/exchange/stream` is Server-Sent Events, not a WebSocket, because an SSE stream is a plain HTTP response and is certain to reach an Express app running as a Vercel Function, where a WebSocket upgrade is not. A client subscribes with `?channels=book:BTC-USDT,trades:BTC-USDT&since=<seq>`, and the server replays every event after `since` first, then tails new ones every second, with a heartbeat comment every 15 seconds. At four minutes fifty seconds the server sends a `reconnect` event and ends the response; the client reconnects with the last `seq` it saw and, because sequence numbers never skip, misses nothing.

**Rejections.** A rejected order still gets an id and a stable reason, never a bare error.

| Reason | Meaning |
|---|---|
| `market_halted` | the market is not accepting orders right now |
| `price_not_tick` | the price is not a multiple of the market's tick size |
| `quantity_not_lot` | the quantity is not a multiple of the market's lot size |
| `below_min_notional` | price times quantity falls under the market's minimum |
| `insufficient_funds` | the hold this order needs cannot be covered |
| `post_only_would_take` | a post only order would have filled immediately |
| `fok_not_fillable` | a fill or kill order could not fill in full |
| `duplicate_client_order_id` | this key already used that client order id with a different order |
| `self_trade` | this order would fill against the same key's own resting order |
| `notional_too_large` | price times quantity does not fit back into the exchange's integer arithmetic |

## Limits

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

Ceilings apply to sandbox keys and their ledgers. A ceiling hit is a 409 `sandbox_limit_reached` naming the ceiling.

| Exchange ceiling | Value |
|---|---|
| Endpoint weight | 1,200 per minute per key |
| Order placement | capped separately at 10 per second per key |
| Faucet | once per 24 hours per sandbox key |
| Public market data reads | cached 2 seconds, weight charged per address |
| Concurrent streams | 10 per address |
| Public exchange verify | 2 per minute per address |

## Running it locally

```bash
cp .env.example .env
npm install
npm run migrate
npm run dev
npm test
```

## Design

The full design is at `docs/superpowers/specs/2026-09-04-plutus-design.md`. The plan that built it, task by task, is at `docs/superpowers/plans/2026-09-04-milestone-one-the-ledger.md`.

## Licence

Source available under the PolyForm Noncommercial License 1.0.0. You may read it, run it and learn from it. Commercial use needs the author's written permission. See `LICENSE.md`.
