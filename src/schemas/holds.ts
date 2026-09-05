import { z } from "zod";
import { AmountString, Iso, Metadata } from "./common.js";
import { TransferOut } from "./transfers.js";
export const HoldCreate = z.object({
  account: z.string().regex(/^acct_[0-9a-f]{32}$/), amount: AmountString,
  expires_in_seconds: z.number().int().min(1).max(7 * 24 * 3600).default(900), memo: z.string().max(200).default(""), metadata: Metadata,
});
export const HoldCapture = z.object({ to: z.string().regex(/^(acct_[0-9a-f]{32}|world:[A-Z]{3,5})$/), amount: AmountString.optional(), release_remainder: z.boolean().default(false) });
export const HoldOut = z.object({
  id: z.string(), ledger_id: z.string(), account_id: z.string(), asset: z.string(), amount: z.string(), remaining: z.string(),
  status: z.enum(["open", "captured", "released", "expired"]), expires_at: Iso, memo: z.string(), metadata: z.record(z.string(), z.string()),
  created_at: Iso, closed_at: Iso.nullable(),
});
export const HoldCaptureOut = z.object({ hold: HoldOut, transfer: TransferOut });
export const HoldReleaseOut = z.object({ hold: HoldOut, released: z.string() });
