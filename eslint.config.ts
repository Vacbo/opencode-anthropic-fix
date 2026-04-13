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
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
            "@typescript-eslint/no-explicit-any": ["warn"],
            "@typescript-eslint/consistent-type-imports": ["warn"],
            "no-console": ["warn"],
            "no-constant-condition": ["error", { checkLoops: false }],
            "prefer-const": "error",
            "no-var": "error",
            eqeqeq: ["error", "smart"],
        },
    },
    {
        // CLI, command, and IPC files legitimately use console for user-facing output.
        files: ["src/cli.ts", "src/commands/**", "src/bun-proxy.ts"],
        rules: {
            "no-console": "off",
        },
    },
    {
        // Test files and build scripts often use any for mocking and have
        // legitimate console output for debugging.
        files: ["**/*.test.ts", "src/__tests__/**", "script/**", "scripts/**", ".opencode/skills/**/scripts/**/*.mjs"],
        rules: {
            "no-console": "off",
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
        },
    },
    {
        ignores: ["dist/", "node_modules/", ".mitm/", ".omc/"],
    },
);
