import { createHash } from "node:crypto";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const GENESIS_HASH: Buffer = Buffer.alloc(32, 0);

/**
 * Keys sorted by UTF-16 code unit, which equals bytewise UTF-8 order for the
 * ASCII keys this system permits. Mirrors canonical_json() in the database;
 * both are pinned to the same vectors in tests.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error("canonical JSON permits only integer numbers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] as JsonValue)}`).join(",")}}`;
}

export function hashEntry(prevHash: Buffer, canonical: string): Buffer {
  return createHash("sha256").update(prevHash).update(Buffer.from(canonical, "utf8")).digest();
}

/**
 * Like canonicalJson (keys sorted bytewise, no whitespace), but permits any finite number,
 * serialised the way JSON.stringify would, instead of throwing on a non integer. Object
 * properties whose value is undefined are omitted, matching JSON.stringify; this is for
 * fingerprinting an already parsed request body, not for the append only ledger, so it never
 * needs to reject a shape the ledger itself would refuse.
 */
export function stableJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
  }
  return "null";
}
