// Verify a Plutus webhook. Twelve lines, no dependencies. Node 18 or later.
import { createHmac, timingSafeEqual } from "node:crypto";
export function verifyPlutusWebhook(secret, signatureHeader, rawBody, toleranceSeconds = 300) {
  const parts = Object.fromEntries(signatureHeader.split(",").map((p) => p.split("=")));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(String(parts.v1 ?? ""), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
