import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@wb/domain": path.resolve(__dirname, "../../packages/domain/src/index.ts"),
      "@wb/db/memory": path.resolve(
        __dirname,
        "../../packages/db/src/memory.ts",
      ),
      "@wb/db": path.resolve(__dirname, "../../packages/db/src/index.ts"),
    },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.tsx", "src/**/*.test.ts"],
  },
});
