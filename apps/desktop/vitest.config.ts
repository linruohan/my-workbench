import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const pkg = (rel: string) => path.resolve(__dirname, rel);

export default defineConfig({
  plugins: [react()],
  resolve: {
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
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.tsx", "src/**/*.test.ts"],
  },
});
