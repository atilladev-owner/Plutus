import { describe, it, expect } from "vitest";
import { createPool } from "../../src/db/pool.js";

describe("the pool", () => {
  it("survives an idle client error instead of crashing the process", async () => {
    const seen: string[] = [];
    const pool = createPool("postgres://nobody:nothing@127.0.0.1:1/none", (err) => seen.push(err.message));
    expect(() => pool.emit("error", new Error("idle client dropped"))).not.toThrow();
    expect(seen).toEqual(["idle client dropped"]);
    await pool.end();
  });
});
