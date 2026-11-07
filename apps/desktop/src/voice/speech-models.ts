import {
  FUNASR_ARCHIVE,
  LLAMA_BIN_ARCHIVE,
  QWENCTC_FILES,
  SENSEVOICE_FILES,
  speechEngineDownloadGuide,
  type SpeechEngineId,
} from "@wb/domain";
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

export type SpeechDownloadProgress = {
  engine: string;
  name: string;
  phase: string;
  current: number;
  total: number;
  percent: number;
  index: number;
  count: number;
  message: string;
};

type HostEnsure = {
  dir: string;
  ready: boolean;
  error?: string | null;
  phase: string;
};

export type SpeechEngineOptions = {
  engine: SpeechEngineId;
};

export const SPEECH_DOWNLOAD_PROGRESS_EVENT = "speech-download-progress";

export function currentSpeechEngineOptions(): SpeechEngineOptions {
  return { engine: readPrefs().voiceInputEngine };
}

function engineArgs(options?: Partial<SpeechEngineOptions>) {
  return {
    engine: options?.engine ?? currentSpeechEngineOptions().engine,
  };
}

function archivePayload(spec: typeof FUNASR_ARCHIVE) {
  return {
    name: spec.name,
    relDir: spec.relDir,
    url: spec.url,
    mirrorUrl: spec.mirrorUrl,
    minBytes: spec.minBytes,
    markers: [...spec.markers],
  };
}

function filePayload(file: (typeof SENSEVOICE_FILES)[number]) {
  return {
    name: file.name,
    relPath: file.relPath,
    url: file.url,
    mirrorUrl: file.mirrorUrl,
    minBytes: file.minBytes,
    sha256: file.sha256,
  };
}

/** Missing-model error text with download links and target directory. */
export function speechMissingModelMessage(
  engine: SpeechEngineId,
  modelDir?: string,
): string {
  return speechEngineDownloadGuide(engine, modelDir);
}

export async function subscribeSpeechDownloadProgress(
  onProgress: (progress: SpeechDownloadProgress) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<SpeechDownloadProgress>(SPEECH_DOWNLOAD_PROGRESS_EVENT, (event) => {
    onProgress(event.payload);
  });
}

async function invokeEnsure(
  engine: SpeechEngineId,
  args: {
    files?: ReturnType<typeof filePayload>[];
    archives?: ReturnType<typeof archivePayload>[];
  },
): Promise<SpeechEnsureResult> {
  if (!isTauriRuntime()) {
    return {
      ok: false,
      skipped: true,
      message: "语音模型需要在桌面应用里准备到配置目录。",
      phase: "unprepared",
    };
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<HostEnsure>("speech_ensure_models", {
      engine,
      files: args.files ?? [],
      archives: args.archives ?? [],
      proxy: readPrefs().httpProxy.trim() || null,
    });
    if (result.ready) {
      return { ok: true, dir: result.dir, phase: result.phase || "ready" };
    }
    const base = result.error?.trim() || "模型文件未就绪";
    const phase = result.phase || "failed";
    if (phase === "cancelled" || base === "已终止下载") {
      return {
        ok: false,
        skipped: false,
        message: "已终止下载",
        phase: "cancelled",
      };
    }
    return {
      ok: false,
      skipped: false,
      message: `${base}\n\n${speechEngineDownloadGuide(engine, result.dir)}`,
      phase,
    };
  } catch (error) {
    const message =
      typeof error === "string"
        ? error.trim()
        : error instanceof Error
          ? error.message.trim()
          : "";
    if (message === "已终止下载") {
      return {
        ok: false,
        skipped: false,
        message: "已终止下载",
        phase: "cancelled",
      };
    }
    return {
      ok: false,
      skipped: false,
      message: message
        ? `${message}\n\n${speechEngineDownloadGuide(engine)}`
        : speechEngineDownloadGuide(engine),
      phase: "failed",
    };
  }
}

/** Ask the host to stop the in-flight speech model download. */
export async function cancelSpeechDownload(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("speech_cancel_download");
  } catch {
    return false;
  }
}

/** Download or verify SenseVoice weights under AppData/models/sensevoice. */
export function ensureSenseVoice(): Promise<SpeechEnsureResult> {
  return invokeEnsure("sensevoice", {
    files: SENSEVOICE_FILES.map(filePayload),
  });
}

async function ensureFunAsr(): Promise<SpeechEnsureResult> {
  return invokeEnsure("funasr", {
    archives: [archivePayload(FUNASR_ARCHIVE), archivePayload(LLAMA_BIN_ARCHIVE)],
  });
}

async function ensureQwenCtc(): Promise<SpeechEnsureResult> {
  return invokeEnsure("qwenctc", {
    files: QWENCTC_FILES.map(filePayload),
    archives: [archivePayload(LLAMA_BIN_ARCHIVE)],
  });
}

/** Prepare the currently selected speech engine into AppData/models/<engine>. */
export async function ensureSpeechEngine(
  options?: Partial<SpeechEngineOptions>,
): Promise<SpeechEnsureResult> {
  const { engine } = engineArgs(options);
  if (engine === "funasr") return ensureFunAsr();
  if (engine === "qwenctc") return ensureQwenCtc();
  return ensureSenseVoice();
}

export async function readSpeechStatus(
  options?: Partial<SpeechEngineOptions>,
): Promise<SpeechStatusResult> {
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
    return await invoke<SpeechStatusResult>("speech_status", engineArgs(options));
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

let warmInflight: Promise<boolean> | null = null;
let warmKey = "";

/** Preload the persistent speech worker. */
export function warmSpeechEngine(
  options?: Partial<SpeechEngineOptions>,
): Promise<boolean> {
  if (!isTauriRuntime()) return Promise.resolve(false);
  const resolved = engineArgs(options);
  const key = resolved.engine;
  if (warmInflight && warmKey === key) return warmInflight;
  warmKey = key;
  warmInflight = (async () => {
    const status = await readSpeechStatus(resolved);
    if (!status.ready) return false;
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("speech_warm", resolved);
  })()
    .catch(() => false)
    .finally(() => {
      warmInflight = null;
      warmKey = "";
    });
  return warmInflight;
}

/** @deprecated Prefer warmSpeechEngine. */
export function warmSenseVoice(): Promise<boolean> {
  return warmSpeechEngine({ engine: "sensevoice" });
}
