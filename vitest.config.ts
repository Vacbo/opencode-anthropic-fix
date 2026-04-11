import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/__tests__/helpers/**/*.test.ts", "index.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "src/__tests__/helpers/deferred.ts",
      "src/__tests__/helpers/in-memory-storage.ts",
      "src/__tests__/helpers/sse.ts",
      "src/__tests__/helpers/conversation-history.ts",
      "src/__tests__/helpers/plugin-fetch-harness.ts",
    ],
    globals: true,
    environment: "node",
  },
});
