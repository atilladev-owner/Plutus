export interface Cursor { t: string; id: string }

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.t, c.id]), "utf8").toString("base64url");
}

export function decodeCursor(s: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [t, id] = parsed as unknown[];
    if (typeof t !== "string" || typeof id !== "string") return null;
    return { t, id };
  } catch {
    return null;
  }
}
