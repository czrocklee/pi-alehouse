import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

const unused = {
  args: "all",
  argsIgnorePattern: "^_",
  caughtErrors: "all",
  caughtErrorsIgnorePattern: "^_",
  ignoreRestSiblings: true,
};

// The Pi panel adapter is also part of orchestration's TS project. Other
// extensions use the separate post-build extension typecheck.
const typedSources = ["src/orchestration/**/*.ts", "src/extensions/lib/centered-panel.ts"];

export default defineConfig(
  { basePath: import.meta.dirname, ignores: ["dist/**", "generated/**", "node_modules/**"] },
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  {
    basePath: import.meta.dirname,
    files: ["test/**/*.mjs", "src/shared/**/*.mjs", ...typedSources],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.nodeBuiltin },
    rules: { "no-unused-vars": ["error", unused] },
  },
  {
    basePath: import.meta.dirname,
    files: typedSources,
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", unused],
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: false }],
      // Async SDK/port implementations retain their Promise/rejection contract
      // even when a particular implementation currently needs no await.
      "@typescript-eslint/require-await": "off",
    },
  },
);
