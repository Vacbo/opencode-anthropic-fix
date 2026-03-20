import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: "module",
      globals: {
        // Node.js globals
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        fetch: "readonly",
        Request: "readonly",
        Response: "readonly",
        Headers: "readonly",
        ReadableStream: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        globalThis: "readonly",
        structuredClone: "readonly",
        btoa: "readonly",
        atob: "readonly",
        crypto: "readonly",
        Buffer: "readonly",
        Blob: "readonly",
        FormData: "readonly",
        File: "readonly",
      },
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
      "no-constant-condition": ["error", { checkLoops: false }],
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "smart"],
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    ignores: ["dist/", "node_modules/", ".mitm/", ".omc/"],
  },
);
