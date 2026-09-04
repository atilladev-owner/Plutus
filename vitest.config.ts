import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/setup/global-setup.ts"],
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 180_000,
    fileParallelism: true,
  },
});
