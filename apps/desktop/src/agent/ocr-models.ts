import { PADDLEOCR_FILES } from "@wb/domain";
import { isTauriRuntime } from "../lib/paths";
import { readPrefs } from "../lib/prefs";

export type OcrEnsureResult =
  { ok: true; dir: string } | { ok: false; skipped: boolean; message: string };

type HostEnsure = {
  dir: string;
  ready: boolean;
  error?: string | null;
};

type EnsureDeps = {
  tauri?: boolean;
  proxy?: string;
  invoke?: (command: string, args: Record<string, unknown>) => Promise<HostEnsure>;
};

let inflight: Promise<OcrEnsureResult> | null = null;

async function runEnsure(deps: EnsureDeps): Promise<OcrEnsureResult> {
  const tauri = deps.tauri ?? isTauriRuntime();
  if (!tauri) {
    return {
      ok: false,
      skipped: true,
      message: "识图模型需要在桌面应用里下载到配置目录。",
    };
  }
  const invoke =
    deps.invoke ??
    (async (command, args) => {
      const { invoke: call } = await import("@tauri-apps/api/core");
      return call<HostEnsure>(command, args);
    });
  try {
    const result = await invoke("ocr_ensure_models", {
      files: PADDLEOCR_FILES.map((file) => ({
        name: file.name,
        url: file.url,
        minBytes: file.minBytes,
      })),
      proxy: (deps.proxy ?? readPrefs().httpProxy).trim() || null,
    });
    if (result.ready) return { ok: true, dir: result.dir };
    return {
      ok: false,
      skipped: false,
      message: result.error?.trim() || "下载失败",
    };
  } catch (error) {
    const message =
      typeof error === "string"
        ? error.trim()
        : error instanceof Error
          ? error.message.trim()
          : "";
    return { ok: false, skipped: false, message: message || "下载失败" };
  }
}

/** Download PP-OCRv4 into the config directory. Repeated calls share one attempt. */
export function ensurePaddleOcr(deps?: EnsureDeps): Promise<OcrEnsureResult> {
  if (deps) return runEnsure(deps);
  inflight ??= runEnsure({}).finally(() => {
    inflight = null;
  });
  return inflight;
}
