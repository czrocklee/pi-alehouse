import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

const unused = { args: "all", argsIgnorePattern: "^_", caughtErrors: "all", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true };

export default defineConfig(
  { basePath: import.meta.dirname, ignores: ["dist/**", "node_modules/**"] },
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  {
    basePath: import.meta.dirname,
    files: ["**/*.mjs", "src/**/*.ts"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.nodeBuiltin },
    rules: { "no-unused-vars": ["error", unused] },
  },
  {
    basePath: import.meta.dirname,
    files: ["src/**/*.ts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", unused],
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: false }],
      // Async SDK/port implementations retain their Promise/rejection contract
      // even when a particular implementation currently needs no await.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    basePath: fileURLToPath(new URL("../lib/", import.meta.url)),
    files: ["**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.nodeBuiltin },
    rules: { "no-unused-vars": ["error", unused] },
  },
);
