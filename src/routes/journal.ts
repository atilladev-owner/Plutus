import { z } from "zod";
import { defineRoute } from "../platform/route.js";
import { withTx } from "../db/pool.js";
import * as L from "../db/ledger.js";
import { IdParam } from "../schemas/common.js";
import { JournalEntryOut, JournalQuery } from "../schemas/journal.js";
import { ownLedger } from "./ledgers.js";

export const journalRoutes = [
  defineRoute({
    method: "get", path: "/v1/ledgers/{id}/journal", summary: "The journal, oldest first", tag: "Journal", auth: "bearer", scope: "ledger:read",
    params: z.object({ id: IdParam("ldg") }), query: JournalQuery, response: z.object({ data: z.array(JournalEntryOut), next_since: z.string().nullable() }),
    handler: async ({ deps, key, params, query }) => withTx(deps.pool, async (c) => {
      const ledger = await ownLedger(c, key!.id, params.id);
      const rows = await L.listJournal(c, ledger.id, BigInt(query.since), query.limit + 1);
      const data = rows.slice(0, query.limit).map((r) => ({
        seq: r.seq, kind: r.kind, entity_id: r.entity_id, payload: r.payload,
        prev_hash: r.prev_hash.toString("hex"), hash: r.hash.toString("hex"), created_at: r.created_at.toISOString(),
      }));
      return { data, next_since: rows.length > query.limit ? data[data.length - 1]!.seq : null };
    }),
  }),
];
