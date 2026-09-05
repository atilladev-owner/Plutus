import { z } from "zod";
import { Iso } from "./common.js";
export const JournalEntryOut = z.object({ seq: z.string(), kind: z.string(), entity_id: z.string(), payload: z.record(z.string(), z.unknown()), prev_hash: z.string(), hash: z.string(), created_at: Iso });
export const JournalQuery = z.object({ since: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(100) });
