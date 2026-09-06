# Plutus

A ledger you can audit and an exchange you can trade against.

![ci](https://github.com/atilladev-owner/Plutus/actions/workflows/ci.yml/badge.svg)

## What it is

Plutus is a multi asset ledger, and from milestone two a paper trading exchange, exposed as a single HTTP API. Every account is double entry, every transfer runs as one Postgres function under row locks, and every write appends to a hash chained journal anyone can verify. Idempotency keys make a retried write safe, and webhook deliveries are signed and retried on a fixed schedule. The whole surface is asserted by a test suite of 151 tests across 37 files, run against a real Postgres, not a mock.

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
