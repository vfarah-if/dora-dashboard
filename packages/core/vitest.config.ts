import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The hostile input tests compare growth over five runs of each size (test/growth.ts), which takes about 0.1 s on a
    // laptop and up to 6 s on a busy CI runner under coverage. The 5 s default would be the fixed budget that growth
    // ratios exist to avoid, so a slow runner rather than slow code failed them.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/types.ts"],
      // Every workspace shares one floor of 90% on every measure (ADR 0018).
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
