import { describe, it, expect } from "vitest";
import { MemoryRateLimiter } from "../../src/platform/ratelimit.js";

describe("MemoryRateLimiter", () => {
  it("allows the configured points inside the window and refuses the next", async () => {
    let t = 1_000_000;
    const l = new MemoryRateLimiter(() => t);
    for (let i = 0; i < 5; i++) expect((await l.limit("mint", "1.2.3.4")).ok).toBe(true);
    const sixth = await l.limit("mint", "1.2.3.4");
    expect(sixth.ok).toBe(false);
    expect(sixth.remaining).toBe(0);
    t += 3600 * 1000 + 1;
    expect((await l.limit("mint", "1.2.3.4")).ok).toBe(true);
  });
  it("keeps identifiers apart", async () => {
    const l = new MemoryRateLimiter();
    for (let i = 0; i < 5; i++) await l.limit("mint", "a");
    expect((await l.limit("mint", "b")).ok).toBe(true);
  });
});
