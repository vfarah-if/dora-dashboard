/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5181,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: false } },
  },
  preview: { port: 5181, strictPort: true },
  build: {
    rolldownOptions: {
      output: {
        // Vendor outranks charts so React stays in vendor rather than following Recharts into charts.
        codeSplitting: {
          groups: [
            {
              name: "vendor",
              test: /[\\/]node_modules[\\/](react|react-dom|react-router|@tanstack[\\/](react-query|query-core))[\\/]/,
              priority: 2,
            },
            { name: "charts", test: /[\\/]node_modules[\\/]recharts[\\/]/, priority: 1 },
          ],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/test/**", "src/main.tsx", "src/vite-env.d.ts"],
      reporter: ["text-summary", "text"],
      // Every workspace shares one floor of 90% on every measure (ADR 0018).
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
