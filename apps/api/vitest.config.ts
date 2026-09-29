import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The composition root and CLI only wire adapters together; they are exercised by running them.
      exclude: ["src/main.ts", "src/cli.ts", "src/interfaces/**"],
      thresholds: { lines: 85, functions: 85, branches: 80, statements: 85 },
    },
  },
});
