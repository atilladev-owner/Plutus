import { z } from "zod";
import { AmountString, AccountRef, Iso, Metadata } from "./common.js";
export const LegIn = z.object({
  from: AccountRef.optional(), from_hold: z.string().regex(/^hold_[0-9a-f]{32}$/).optional(),
  to: AccountRef, asset: z.string().regex(/^[A-Z]{3,5}$/), amount: AmountString,
}).refine((l) => (l.from ? 1 : 0) + (l.from_hold ? 1 : 0) === 1, { message: "exactly one of from or from_hold", path: ["from"] });
export const TransferCreate = z.object({ legs: z.array(LegIn).min(1).max(20), memo: z.string().max(200).default(""), metadata: Metadata });
export const LegOut = z.object({ position: z.number().int(), from: z.string(), from_hold: z.string().nullable(), to: z.string(), asset: z.string(), amount: z.string() });
export const TransferOut = z.object({ id: z.string(), ledger_id: z.string(), seq: z.string(), memo: z.string(), metadata: z.record(z.string(), z.string()), legs: z.array(LegOut), created_at: Iso });
