import js from "@eslint/js";
import globals from "globals";
import pluginN from "eslint-plugin-n";
import eslintConfigPrettier from "eslint-config-prettier";

export default [
  {
    ignores: ["node_modules/**", "coverage/**", "eslint.config.mjs", "loadtest/k6/**", "scratch/**"],
  },
  js.configs.recommended,
  pluginN.configs["flat/recommended-module"],
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": ["error", { allow: ["warn", "error"] }],
      "no-extra-boolean-cast": "off",
      "no-useless-escape": "off",
      "no-useless-assignment": "off",
      "n/no-unsupported-features/node-builtins": "off",
      "n/no-missing-require": "off",
      "n/no-unpublished-require": "off",
      "n/no-process-exit": "off",
      "n/preserve-caught-error": "off",
      "preserve-caught-error": "off",
      "preserve-caught-error": "off",
    },
  },
  {
    files: ["scripts/**/*.js", "__tests__/**/*.js"],
    rules: {
      "no-console": "off",
    },
  },
  eslintConfigPrettier,
];
