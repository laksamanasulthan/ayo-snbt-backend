import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 120000,
    // Integration suites share the compose database — run files sequentially
    // to avoid TRUNCATE deadlocks between parallel workers.
    fileParallelism: false
  }
});