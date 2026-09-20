import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "jsdom",
    globals: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // `server-only` throws outside a Next.js server build; tests are not one.
      "server-only": path.resolve(__dirname, "./src/test/emptyModule.ts"),
    },
  },
});
