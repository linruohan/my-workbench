import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const pkg = (rel: string) => path.resolve(rootDir, rel);
const workspaceRoot = path.resolve(rootDir, "../..");

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Exact matches only: a bare "@wb/theme" -> index.ts alias must not
    // swallow "@wb/theme/tokens.css" as index.ts/tokens.css.
    alias: [
      {
        find: /^@wb\/domain$/,
        replacement: pkg("../../packages/domain/src/index.ts"),
      },
      {
        find: /^@wb\/theme\/tokens\.css$/,
        replacement: pkg("../../packages/theme/src/tokens.css"),
      },
      {
        find: /^@wb\/theme$/,
        replacement: pkg("../../packages/theme/src/index.ts"),
      },
      {
        find: /^@wb\/db\/memory$/,
        replacement: pkg("../../packages/db/src/memory.ts"),
      },
      {
        find: /^@wb\/db$/,
        replacement: pkg("../../packages/db/src/index.ts"),
      },
    ],
  },
  clearScreen: false,
  // Prevent Vite from clearing Tauri's Rust compile logs.
  envPrefix: ["VITE_", "TAURI_"],
  server: {
    port: 5173,
    strictPort: true,
    // Monorepo: watch domain/db/theme so edits hot-reload into the desktop shell.
    watch: {
      ignored: ["**/src-tauri/**", "**/target/**", "**/node_modules/**"],
    },
    fs: {
      allow: [workspaceRoot],
    },
  },
  optimizeDeps: {
    exclude: ["@wb/domain", "@wb/db", "@wb/theme"],
  },
  build: {
    // Tauri expects relative asset paths inside the WebView.
    target: "esnext",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
