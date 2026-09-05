import { describe, it, expect } from "vitest";
import fc from "fast-check";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";
import { withTx } from "../../src/db/pool.js";
import * as L from "../../src/db/ledger.js";
import { verifyChain } from "../../src/domain/verify.js";
import type { RateLimiter } from "../../src/platform/ratelimit.js";

type Op =
  | { kind: "fund"; account: number; amount: bigint }
  | { kind: "transfer"; from: number; to: number; amount: bigint }
  | { kind: "hold"; account: number; amount: bigint }
  | { kind: "capture"; hold: number; amount: bigint; releaseRemainder: boolean }
  | { kind: "release"; hold: number };

const amount = fc.bigInt({ min: 1n, max: 5_000n });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("fund" as const), account: fc.nat(3), amount }),
  fc.record({ kind: fc.constant("transfer" as const), from: fc.nat(3), to: fc.nat(3), amount }),
  fc.record({ kind: fc.constant("hold" as const), account: fc.nat(3), amount }),
  fc.record({ kind: fc.constant("capture" as const), hold: fc.nat(20), amount, releaseRemainder: fc.boolean() }),
  fc.record({ kind: fc.constant("release" as const), hold: fc.nat(20) }),
);

// This suite mints a key and drives thousands of requests through one process; the real
// mint (five an hour) and sandbox (sixty a minute) limits exist to protect production
// from exactly that pattern, so they would fail every run for a reason that has nothing
// to do with the ledger invariants under test. The limiter is swapped for one that
// always says yes, the same override shape tests/integration/ratelimit.test.ts uses to
// force the opposite outcome.
const noRateLimits: RateLimiter = { limit: async () => ({ ok: true, limit: 1_000_000, remaining: 1_000_000, resetAt: Date.now() + 1000 }) };

describe("ledger invariants under random operation sequences", () => {
  it("conservation, non negative available, held equals open holds, chain verifies", async () => {
    const { app, deps } = await makeTestApp({ limiter: noRateLimits });
    await fc.assert(fc.asyncProperty(fc.array(opArb, { minLength: 20, maxLength: 60 }), async (ops) => {
      const k = await mintKey(app);
      const h = bearer(k.secret);
      const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "p" })).body;
      const accounts: string[] = [];
      for (let i = 0; i < 4; i++) accounts.push((await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "GHS", name: `a${i}` })).body.id);
      const holds: string[] = [];
      for (const op of ops) {
        if (op.kind === "fund") await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:GHS", to: accounts[op.account], asset: "GHS", amount: op.amount.toString() }] });
        else if (op.kind === "transfer") await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: accounts[op.from], to: accounts[op.to], asset: "GHS", amount: op.amount.toString() }] });
        else if (op.kind === "hold") { const r = await request(app).post(`/v1/ledgers/${l.id}/holds`).set(h).send({ account: accounts[op.account], amount: op.amount.toString() }); if (r.status === 201) holds.push(r.body.id); }
        else if (op.kind === "capture" && holds.length) await request(app).post(`/v1/ledgers/${l.id}/holds/${holds[op.hold % holds.length]}/capture`).set(h).send({ to: accounts[0], amount: op.amount.toString(), release_remainder: op.releaseRemainder });
        else if (op.kind === "release" && holds.length) await request(app).post(`/v1/ledgers/${l.id}/holds/${holds[op.hold % holds.length]}/release`).set(h).send({});
      }
      // Every response is either a success or a well formed refusal; the invariants must hold regardless.
      const { rows } = await deps.pool.query<{ id: string; kind: string; balance: string; held: string; open_held: string }>(
        `select a.id, a.kind, a.balance::text, a.held::text,
                coalesce((select sum(remaining) from holds hh where hh.account_id = a.id and hh.status = 'open'), 0)::text as open_held
         from accounts a where a.ledger_id = $1`, [l.id]);
      let sum = 0n;
      for (const r of rows) {
        sum += BigInt(r.balance);
        expect(BigInt(r.held)).toBe(BigInt(r.open_held));
        if (r.kind === "normal") expect(BigInt(r.balance) - BigInt(r.held) >= 0n).toBe(true);
      }
      expect(sum).toBe(0n);
      const stored = new Map(rows.map((r) => [r.id, { balance: BigInt(r.balance), held: BigInt(r.held) }]));
      const report = await withTx(deps.pool, async (c) => {
        async function* entries() { let since = 0n; for (;;) { const b = await L.listJournal(c, l.id, since, 500); if (!b.length) return; yield* b; since = BigInt(b[b.length - 1]!.seq); } }
        return verifyChain(entries(), stored);
      });
      expect(report.ok).toBe(true);
    }), { numRuns: 25, endOnFailure: true });
  }, 300_000);
});
