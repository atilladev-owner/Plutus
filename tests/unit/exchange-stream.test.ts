import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import type { Pool } from "pg";
import type { AppDeps } from "../../src/deps.js";
import { streamHandler } from "../../src/routes/exchange-stream.js";

// A slow reader must never make exchange-stream.ts buffer an unbounded amount of unsent
// data (task 8 fix round 1, finding 2). The integration suite (tests/integration/stream.test.ts)
// runs against a real socket, where forcing res.write to actually return false is not
// deterministic without controlling the client's own read rate at the OS level. This file
// drives streamHandler directly against a fake request and response instead, so a single
// controlled write() return value proves the pause and the resume without any of that.

class FakeReq extends EventEmitter {
  ip = "127.0.0.1";
  constructor(public query: Record<string, unknown>) { super(); }
}

class FakeRes extends EventEmitter {
  written: string[] = [];
  ended = false;
  constructor(private readonly writeReturn: (callNumber: number) => boolean) { super(); }
  set(): this { return this; }
  status(): this { return this; }
  flushHeaders(): void { /* no real headers to flush */ }
  write(chunk: string): boolean {
    this.written.push(chunk);
    return this.writeReturn(this.written.length);
  }
  end(): void { this.ended = true; }
}

function dataOf(frame: string): { channel: string; seq: string; data: Record<string, unknown> } {
  const line = frame.split("\n").find((l) => l.startsWith("data: "));
  if (!line) throw new Error("frame carried no data line");
  return JSON.parse(line.slice("data: ".length)) as { channel: string; seq: string; data: Record<string, unknown> };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("streamHandler backpressure", () => {
  it("stops writing once res.write returns false, then sends the rest in order once drain fires", async () => {
    const rows = [1, 2, 3, 4].map((n) => ({
      market: "BTC-USDT",
      seq: String(n),
      type: "order.accepted",
      payload: { order_id: `ord_${n}`, side: n % 2 === 0 ? "buy" : "sell", type: "limit" },
      created_at: new Date(),
    }));
    const poolQuery = vi.fn().mockResolvedValue({ rows });
    const fakePool = { query: poolQuery } as unknown as Pool;
    const fakeLogger = { error: vi.fn() } as unknown as AppDeps["logger"];
    const fakeDeps = { pool: fakePool, logger: fakeLogger } as unknown as AppDeps;

    // The first write (row 1's book delta) reports backpressure; every later write is
    // accepted, so anything beyond one written frame before drain fires would mean the
    // paused state was not respected.
    const fakeRes = new FakeRes((callNumber) => callNumber !== 1);
    const fakeReq = new FakeReq({ channels: "book:BTC-USDT", since: "0" });

    const done = streamHandler(fakeReq as unknown as Request, fakeRes as unknown as Response, fakeDeps);

    await waitUntil(() => fakeRes.written.length >= 1);
    expect(fakeRes.written).toHaveLength(1);
    const first = dataOf(fakeRes.written[0]!);
    expect(first.seq).toBe("1");
    expect(typeof first.data.at).toBe("string");

    // A real, if short, wait: proves the pause holds rather than the next write simply
    // not having happened yet.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fakeRes.written).toHaveLength(1);

    fakeRes.emit("drain");
    await done;

    expect(fakeRes.written).toHaveLength(4);
    expect(fakeRes.written.map((frame) => dataOf(frame).seq)).toEqual(["1", "2", "3", "4"]);
    for (const frame of fakeRes.written) expect(typeof dataOf(frame).data.at).toBe("string");
    // Four rows is under EVENTS_PAGE_LIMIT, so the paged replay loop should have queried
    // exactly once, not looped back for a second, empty page.
    expect(poolQuery).toHaveBeenCalledTimes(1);

    fakeReq.emit("close");
  });
});
