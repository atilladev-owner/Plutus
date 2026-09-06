import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/setup/global-setup.ts"],
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 180_000,
    fileParallelism: true,
    maxWorkers: 6,
    // vitest 4 moved this out of poolOptions.forks.execArgv (a shape it no longer types or
    // reads) to a plain top level field; unrelated to task 5, fixed here only because it
    // otherwise fails tsc --noEmit and blocks the house rule that npm run build stay clean.
    execArgv: ["--max-old-space-size=4096"],
  },
});
