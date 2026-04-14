import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["tests/**/*.test.ts", "scripts/**/*.test.ts", "index.test.ts", "cli.test.ts"],
        exclude: [
            "**/node_modules/**",
            "**/dist/**",
            "tests/helpers/deferred.ts",
            "tests/helpers/in-memory-storage.ts",
            "tests/helpers/sse.ts",
            "tests/helpers/conversation-history.ts",
            "tests/helpers/plugin-fetch-harness.ts",
        ],
        globals: true,
        environment: "node",
    },
});
