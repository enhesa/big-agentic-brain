import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    // e2e tests boot a real server and have their own config/runner
    // (vitest.e2e.config.mts, `pnpm test:e2e`); the default `vitest run`
    // must stay green with no server running.
    // Keep vitest defaults (node_modules, dist, ...) or the e2e build output
    // under .next/standalone gets collected as tests.
    // evals/tasks holds the benchmark's own sample repos (with their own node:test files); evals run via `pnpm eval`.
    exclude: [...configDefaults.exclude, "tests/e2e/**", ".next/**", "evals/**"],
    // Page render tests import the whole app tree on first run; 5s flakes under load.
    testTimeout: 20000,
    // node:sqlite (DatabaseSync) doesn't play well with vitest's default vm-forks
    // pool when modules are inlined/transformed; run each test file in its own
    // real Node process instead.
    pool: "forks",
    setupFiles: ["tests/setup-env.ts"],
    // One fork per test file, run concurrently, means the p95 latency
    // assertions in tests/perf.test.ts get noisy under CPU contention from
    // dozens of other Node processes racing on the same machine — the
    // absolute queries are fast (low single-digit ms in isolation) but a
    // scheduler-starved run can blow well past a 25ms budget for reasons
    // that have nothing to do with the query plan. Running files
    // sequentially removes that source of noise; the suite is still small
    // enough (well under 60s) for that to be the right trade.
    fileParallelism: false,
    server: {
      deps: {
        inline: ["node:sqlite"],
      },
    },
    coverage: {
      provider: "v8",
      include: ["lib/**", "app/api/**", "app/instructions/**"],
      reporter: ["text", "lcov"],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 75,
      },
    },
  },
});
