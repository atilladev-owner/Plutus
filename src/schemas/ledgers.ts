import { z } from "zod";
import { Iso } from "./common.js";
export const LedgerCreate = z.object({ name: z.string().min(1).max(80) });
export const LedgerOut = z.object({ id: z.string(), name: z.string(), next_seq: z.string(), head_hash: z.string(), last_activity_at: Iso, created_at: Iso });
