import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The composition root and CLI only wire adapters together; they are exercised by running them.
      exclude: ["src/main.ts", "src/cli.ts", "src/interfaces/**"],
      // Every workspace shares one floor of 90% on every measure (ADR 0018).
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
