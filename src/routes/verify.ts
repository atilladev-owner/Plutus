import { z } from "zod";
import { defineRoute } from "../platform/route.js";
import { withTx } from "../db/pool.js";
import * as L from "../db/ledger.js";
import { IdParam } from "../schemas/common.js";
import { ownLedger } from "./ledgers.js";
import { verifyChain } from "../domain/verify.js";

const Report = z.object({
  ok: z.boolean(), entries_checked: z.number().int(), first_bad_seq: z.string().nullable(),
  chain_ok: z.boolean(), sequence_ok: z.boolean(), replay_matches: z.boolean(),
  assets: z.array(z.object({ asset: z.string(), sum: z.string() })), cached: z.boolean(),
});

export const verifyRoutes = [
  defineRoute({
    method: "get", path: "/v1/ledgers/{id}/verify", summary: "Recompute the whole chain and prove every asset sums to zero", tag: "Journal",
    auth: "bearer", scope: "ledger:read", limit: "verify",
    params: z.object({ id: IdParam("ldg") }), response: Report,
    handler: async ({ deps, key, params }) => withTx(deps.pool, async (c) => {
      const ledger = await ownLedger(c, key!.id, params.id);
      const cacheKey = `verify:${ledger.id}:${ledger.next_seq}`;
      const hit = await deps.cache.get(cacheKey);
      if (hit) return { ...(JSON.parse(hit) as z.infer<typeof Report>), cached: true };
      const { rows } = await c.query<{ id: string; balance: string; held: string }>("select id, balance::text, held::text from accounts where ledger_id = $1", [ledger.id]);
      const stored = new Map(rows.map((r) => [r.id, { balance: BigInt(r.balance), held: BigInt(r.held) }]));
      async function* entries() {
        let since = 0n;
        for (;;) {
          const batch = await L.listJournal(c, ledger.id, since, 500);
          if (batch.length === 0) return;
          for (const row of batch) yield row;
          since = BigInt(batch[batch.length - 1]!.seq);
        }
      }
      const report = await verifyChain(entries(), stored);
      await deps.cache.set(cacheKey, JSON.stringify(report), 60);
      return { ...report, cached: false };
    }),
  }),
];
