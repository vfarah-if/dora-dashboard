// One ESLint config for every workspace, run from the root by `make lint` (ADR 0014).
// Prettier owns layout, so eslint-config-prettier switches off every rule that would argue with it.
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "**/.turbo/**", "data/**", ".run/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  {
    files: ["apps/api/**", "packages/core/**", "scripts/**", "*.{js,mjs,cjs,ts}"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["apps/web/**"],
    languageOptions: { globals: globals.browser },
    ...reactHooks.configs.flat["recommended-latest"],
  },
  prettier,
);
