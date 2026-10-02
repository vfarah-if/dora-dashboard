import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/types.ts"],
      // Every workspace shares one floor of 90% on every measure (ADR 0018).
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
