import { randomBytes } from "node:crypto";

export type IdPrefix = "key" | "ldg" | "acct" | "tr" | "hold" | "whe" | "whd" | "evt" | "ord";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

export function isId(prefix: IdPrefix, s: string): boolean {
  return new RegExp(`^${prefix}_[0-9a-f]{32}$`).test(s);
}
