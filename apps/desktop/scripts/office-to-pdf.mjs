#!/usr/bin/env node
/**
 * Bridge: convert Office → PDF via @deepseek-ai/libreoffice-kit (DSH native JS/C++).
 * Usage: node office-to-pdf.mjs --input <abs> --output <abs.pdf>
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return "";
  return String(process.argv[index + 1] ?? "").trim();
}

function kitCandidates() {
  const out = [];
  if (process.env.WB_LIBREOFFICE_KIT) out.push(process.env.WB_LIBREOFFICE_KIT.trim());
  out.push(join(__dirname, "../node_modules/@deepseek-ai/libreoffice-kit"));
  out.push(join(__dirname, "../../../node_modules/@deepseek-ai/libreoffice-kit"));
  const execDir = dirname(process.execPath);
  out.push(
    join(
      execDir,
      "npm_global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/libreoffice-kit",
    ),
  );
  out.push(
    "C:/software/nodejs/npm_global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/libreoffice-kit",
  );
  return out;
}

async function loadConverter() {
  const require = createRequire(import.meta.url);
  for (const candidate of kitCandidates()) {
    if (!candidate) continue;
    try {
      if (candidate.startsWith("@") || candidate.includes("node_modules") || existsSync(candidate)) {
        const mod = candidate.startsWith("@")
          ? await import(candidate)
          : existsSync(join(candidate, "package.json"))
            ? await import(pathToFileURL(join(candidate, "lib/index.js")).href)
            : null;
        if (mod?.createConverter) return mod.createConverter;
      }
    } catch {
      // try next
    }
    try {
      const resolved = require.resolve("@deepseek-ai/libreoffice-kit", {
        paths: [candidate, dirname(candidate), __dirname, process.cwd()],
      });
      const mod = await import(pathToFileURL(resolved).href);
      if (mod?.createConverter) return mod.createConverter;
    } catch {
      // try next
    }
  }
  try {
    const mod = await import("@deepseek-ai/libreoffice-kit");
    if (mod?.createConverter) return mod.createConverter;
  } catch {
    // fall through
  }
  throw new Error(
    "未找到 @deepseek-ai/libreoffice-kit。请安装 DSH 或设置 WB_LIBREOFFICE_KIT 指向该包目录。",
  );
}

async function main() {
  const inputPath = argValue("--input");
  const outputPath = argValue("--output");
  if (!inputPath || !outputPath) {
    console.error("usage: office-to-pdf.mjs --input <path> --output <path.pdf>");
    process.exit(2);
  }
  if (!existsSync(inputPath)) {
    console.error(`输入不存在: ${inputPath}`);
    process.exit(1);
  }
  const createConverter = await loadConverter();
  const converter = await createConverter({ timeoutMs: 180_000 });
  try {
    const result = await converter.convert({ inputPath, outputPath });
    console.log(`backend=${result.backend}`);
    if (Array.isArray(result.missingFonts) && result.missingFonts.length) {
      console.log(`missingFonts=${result.missingFonts.join(",")}`);
    }
  } finally {
    await converter.dispose();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
