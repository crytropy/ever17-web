import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "adapters/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "e17-parser/test/**/*.test.ts",
      "e17-assets/test/**/*.test.ts",
    ],
    testTimeout: 60_000,
  },
});
