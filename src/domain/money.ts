export const MAX_AMOUNT = 9223372036854775807n;
const AMOUNT_RE = /^(0|[1-9][0-9]*)$/;

export class AmountError extends Error {
  override name = "AmountError";
}

export function parseAmount(s: string, opts: { allowZero?: boolean } = {}): bigint {
  if (typeof s !== "string" || !AMOUNT_RE.test(s)) throw new AmountError("amount must be a decimal string of minor units");
  const n = BigInt(s);
  if (n > MAX_AMOUNT) throw new AmountError("amount exceeds the maximum");
  if (n === 0n && !opts.allowZero) throw new AmountError("amount must be greater than zero");
  return n;
}

export function formatAmount(n: bigint): string {
  return n.toString();
}

/** Human display only. Never fed back into arithmetic. */
export function toDisplay(n: bigint, exponent: number): string {
  const negative = n < 0n;
  const digits = (negative ? -n : n).toString().padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const frac = digits.slice(digits.length - exponent);
  return `${negative ? "-" : ""}${whole}${exponent > 0 ? "." + frac : ""}`;
}
