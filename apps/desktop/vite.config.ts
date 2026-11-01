import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@wb/domain": path.resolve(__dirname, "../../packages/domain/src/index.ts"),
      "@wb/theme": path.resolve(__dirname, "../../packages/theme/src/index.ts"),
      "@wb/theme/tokens.css": path.resolve(
        __dirname,
        "../../packages/theme/src/tokens.css",
      ),
      "@wb/db/memory": path.resolve(__dirname, "../../packages/db/src/memory.ts"),
      "@wb/db": path.resolve(__dirname, "../../packages/db/src/index.ts"),
    },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
});
