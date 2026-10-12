import { defineConfig } from "vitest/config";

// Separate from vitest.config.mts (unit tests): e2e tests boot a real
// standalone server over real HTTP and are inherently slower/serial.
// Kept as its own config so `pnpm test:unit` never pays this cost and
// coverage thresholds (vitest.config.mts) aren't computed over e2e runs.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.e2e.test.ts"],
    // One server, one DATA_DIR, shared across the whole e2e run — must be serial.
    fileParallelism: false,
    globalSetup: ["tests/e2e/global-setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
