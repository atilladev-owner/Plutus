import { describe, it, expect, vi, afterEach } from "vitest";
import { UpstashCache } from "../../src/platform/cache.js";

/**
 * The Upstash REST client answers a GET with {"result": <stored value>}. Left to its
 * defaults it then deserialises that value, so a stored JSON document came back as an
 * object and JSON.parse on it threw "[object Object] is not valid JSON": the public verify
 * routes answered 500 on every cache hit in production. The cache promises strings in and
 * the same strings out, so this pins the raw value coming back untouched.
 */
describe("UpstashCache", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  /** Answers the way the Upstash REST endpoint does: one {"result"} per command, as an array
   * when the client batches commands through /pipeline and as one object otherwise. Records
   * every command sent. */
  function stubRest(result: string) {
    const calls: unknown[][] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
      const pipeline = String(url).endsWith("/pipeline");
      const commands = pipeline ? (body as unknown[][]) : [body as unknown[]];
      for (const c of commands) calls.push(c);
      // The client asks for base64 answers and decodes them itself; the endpoint honours
      // that header, so the stub must too or the decode turns a plain answer into bytes.
      const headers = new Headers(init?.headers);
      const encoded = headers.get("Upstash-Encoding") === "base64" ? Buffer.from(result, "utf8").toString("base64") : result;
      const answer = pipeline ? commands.map(() => ({ result: encoded })) : { result: encoded };
      return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
    }));
    return calls;
  }

  it("returns a stored JSON document as the string that was set, not as an object", async () => {
    const stored = JSON.stringify({ ok: true, entries_checked: 12 });
    stubRest(stored);
    const cache = new UpstashCache("https://cache.example.test", "token");
    const hit = await cache.get("verify:ldg_exchange");
    expect(typeof hit).toBe("string");
    expect(hit).toBe(stored);
    expect(JSON.parse(hit as string)).toEqual({ ok: true, entries_checked: 12 });
  });

  it("returns a stored numeric string as a string", async () => {
    stubRest("7912345");
    const cache = new UpstashCache("https://cache.example.test", "token");
    const hit = await cache.get("reference:BTC-USDT");
    expect(hit).toBe("7912345");
  });

  it("sets the value with the expiry the caller asked for", async () => {
    const calls = stubRest("OK");
    const cache = new UpstashCache("https://cache.example.test", "token");
    await cache.set("k", "{\"a\":1}", 60);
    expect(calls[0]).toEqual(["set", "k", "{\"a\":1}", "ex", 60]);
  });
});
