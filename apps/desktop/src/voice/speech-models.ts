import { SENSEVOICE_FILES } from "@wb/domain";
import { isTauriRuntime } from "../lib/paths";
import { readPrefs } from "../lib/prefs";

export type SpeechEnsureResult =
  | { ok: true; dir: string; phase: string }
  | { ok: false; skipped: boolean; message: string; phase: string };

export type SpeechStatusResult = {
  dir: string;
  ready: boolean;
  phase: string;
  message: string;
};

type HostEnsure = {
  dir: string;
  ready: boolean;
  error?: string | null;
  phase: string;
};

type EnsureDeps = {
  tauri?: boolean;
  proxy?: string;
  invoke?: (command: string, args: Record<string, unknown>) => Promise<HostEnsure>;
};

let inflight: Promise<SpeechEnsureResult> | null = null;

async function runEnsure(deps: EnsureDeps): Promise<SpeechEnsureResult> {
  const tauri = deps.tauri ?? isTauriRuntime();
  if (!tauri) {
    return {
      ok: false,
      skipped: true,
      message: "语音模型需要在桌面应用里准备到配置目录。",
      phase: "unprepared",
    };
  }
  const invoke =
    deps.invoke ??
    (async (command, args) => {
      const { invoke: call } = await import("@tauri-apps/api/core");
      return call<HostEnsure>(command, args);
    });
  try {
    const result = await invoke("speech_ensure_models", {
      files: SENSEVOICE_FILES.map((file) => ({
        name: file.name,
        relPath: file.relPath,
        url: file.url,
        mirrorUrl: file.mirrorUrl,
        minBytes: file.minBytes,
        sha256: file.sha256,
      })),
      proxy: (deps.proxy ?? readPrefs().httpProxy).trim() || null,
    });
    if (result.ready) {
      return { ok: true, dir: result.dir, phase: result.phase || "ready" };
    }
    return {
      ok: false,
      skipped: false,
      message: result.error?.trim() || "准备失败",
      phase: result.phase || "failed",
    };
  } catch (error) {
    const message =
      typeof error === "string"
        ? error.trim()
        : error instanceof Error
          ? error.message.trim()
          : "";
    return {
      ok: false,
      skipped: false,
      message: message || "准备失败",
      phase: "failed",
    };
  }
}

/** Download or adopt SenseVoice weights. Repeated calls share one attempt. */
export function ensureSenseVoice(deps?: EnsureDeps): Promise<SpeechEnsureResult> {
  if (deps) return runEnsure(deps);
  inflight ??= runEnsure({}).finally(() => {
    inflight = null;
  });
  return inflight;
}

export async function readSpeechStatus(): Promise<SpeechStatusResult> {
  if (!isTauriRuntime()) {
    return {
      dir: "",
      ready: false,
      phase: "unprepared",
      message: "语音识别仅在桌面应用中可用。",
    };
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<SpeechStatusResult>("speech_status");
  } catch (error) {
    const message =
      typeof error === "string"
        ? error.trim()
        : error instanceof Error
          ? error.message.trim()
          : "";
    return {
      dir: "",
      ready: false,
      phase: "failed",
      message: message || "无法读取语音状态",
    };
  }
}
