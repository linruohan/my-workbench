import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const ORT_ASSETS = ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"];

function ortAssets(distDir: string, outDir: string): Plugin {
  const serve = (name: string) => {
    if (!ORT_ASSETS.includes(name)) return null;
    const file = path.join(distDir, name);
    return fs.existsSync(file) ? file : null;
  };
  return {
    name: "ort-assets",
    configureServer(server) {
      server.middlewares.use("/ort", (req, res, next) => {
        const name = decodeURIComponent((req.url ?? "").split("?")[0] ?? "").replace(
          /^\/+/,
          "",
        );
        const file = serve(name);
        if (!file) {
          next();
          return;
        }
        res.setHeader(
          "Content-Type",
          name.endsWith(".wasm") ? "application/wasm" : "text/javascript",
        );
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      const out = path.join(outDir, "ort");
      fs.mkdirSync(out, { recursive: true });
      for (const name of ORT_ASSETS) {
        const file = serve(name);
        if (file) fs.copyFileSync(file, path.join(out, name));
      }
    },
  };
}

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const pkg = (rel: string) => path.resolve(rootDir, rel);
const workspaceRoot = path.resolve(rootDir, "../..");

export default defineConfig({
  plugins: [
    react(),
    ortAssets(
      path.join(workspaceRoot, "node_modules/onnxruntime-web/dist"),
      path.join(rootDir, "dist"),
    ),
  ],
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
      {
        find: "onnxruntime-web/wasm",
        replacement: path.join(
          workspaceRoot,
          "node_modules/onnxruntime-web/dist/ort.wasm.min.mjs",
        ),
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
    exclude: ["@wb/domain", "@wb/db", "@wb/theme", "onnxruntime-web"],
  },
  build: {
    // Tauri expects relative asset paths inside the WebView.
    target: "esnext",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
