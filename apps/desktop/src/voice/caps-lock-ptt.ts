import type { SpeechEngineId, SpeechLanguage } from "@wb/domain";
import { isTauriRuntime } from "../lib/paths";
import { Recording, recordingErrorMessage, transcribeRecording } from "./speech-engine";
import { injectVoiceIntoEditable, isVoiceEditable, VOICE_HOLD_MIN_MS } from "./text";

export type CapsLockPttOptions = {
  enabled: boolean;
  deviceId: string;
  language: SpeechLanguage;
  engine: SpeechEngineId;
  setStatus: (message: string | null) => void;
  markReady: () => void;
  openSettings?: () => void;
  notifyMissingModel?: (engine?: SpeechEngineId, modelDir?: string) => void;
};

const LOCK_ID = "voice-dictation:caps-lock";
const EVENT_DOWN = "voice-ptt-down";
const EVENT_UP = "voice-ptt-up";

type CapturedTarget = {
  el: HTMLElement;
  /** selectionStart snapshot for input/textarea; contenteditable uses live selection. */
  start: number | null;
  end: number | null;
};

function captureEditable(): CapturedTarget | null {
  const active = document.activeElement;
  if (!isVoiceEditable(active)) return null;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    return {
      el: active,
      start: active.selectionStart,
      end: active.selectionEnd,
    };
  }
  return { el: active, start: null, end: null };
}

async function writeBack(text: string, target: CapturedTarget | null): Promise<void> {
  const spoken = text.trim();
  if (!spoken) return;

  // Prefer the element that was focused when CapsLock went down.
  const preferred = target?.el && document.contains(target.el) ? target : null;
  const live = isVoiceEditable(document.activeElement)
    ? (document.activeElement as HTMLElement)
    : null;
  const el = preferred?.el ?? live;

  if (el && document.hasFocus()) {
    try {
      el.focus({ preventScroll: true });
      if (
        (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
        preferred &&
        preferred.start != null &&
        preferred.end != null
      ) {
        el.setSelectionRange(preferred.start, preferred.end);
      }
    } catch {
      // ignore focus/selection failures
    }
    if (injectVoiceIntoEditable(el, spoken)) return;
  }

  // Outside the webview / non-editable focus: CapsWriter-style clipboard paste.
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("voice_ptt_paste", { text: spoken });
}

/**
 * CapsWriter-style global Caps Lock PTT (alongside in-box mic buttons):
 * hold to record, release to transcribe, paste into the focused editable
 * (or any OS focus via clipboard paste).
 */
export function startCapsLockPtt(getOptions: () => CapsLockPttOptions): () => void {
  if (!isTauriRuntime()) return () => undefined;

  let disposed = false;
  let pressed = false;
  let startedAt = 0;
  let finishing = false;
  let recording: Recording | null = null;
  let target: CapturedTarget | null = null;
  let unlistenDown: (() => void) | null = null;
  let unlistenUp: (() => void) | null = null;

  const engineOptions = () => ({ engine: getOptions().engine });

  const dropRecording = async () => {
    const current = recording;
    recording = null;
    if (current) await current.dispose();
  };

  const onDown = async () => {
    if (disposed || pressed || finishing || recording) return;
    const opts = getOptions();
    if (!opts.enabled) return;
    pressed = true;
    startedAt = performance.now();
    target = captureEditable();
    opts.setStatus("按住 CapsLock 录音中…");
    try {
      const { readSpeechStatus, warmSpeechEngine } = await import("./speech-models");
      const status = await readSpeechStatus(engineOptions());
      if (!pressed || disposed) return;
      if (!status.ready) {
        pressed = false;
        target = null;
        opts.notifyMissingModel?.(opts.engine, status.dir);
        return;
      }
      opts.markReady();
      void warmSpeechEngine(engineOptions());
      if (!pressed || disposed || recording) return;
      const next = new Recording(opts.deviceId || undefined, LOCK_ID);
      recording = next;
      await next.start();
      if (!pressed || disposed || recording !== next) {
        if (recording === next) recording = null;
        await next.dispose();
      }
    } catch (error) {
      recording = null;
      pressed = false;
      target = null;
      getOptions().setStatus(recordingErrorMessage(error));
    }
  };

  const onUp = async () => {
    if (disposed || finishing) return;
    if (!pressed && !recording) return;
    pressed = false;
    finishing = true;
    const heldMs = performance.now() - startedAt;
    const current = recording;
    const captured = target;
    recording = null;
    target = null;

    if (!current) {
      finishing = false;
      if (heldMs < VOICE_HOLD_MIN_MS) {
        getOptions().setStatus("按住时间太短");
      } else {
        getOptions().setStatus(null);
      }
      return;
    }

    if (heldMs < VOICE_HOLD_MIN_MS) {
      await current.dispose();
      finishing = false;
      getOptions().setStatus("按住时间太短");
      return;
    }

    const opts = getOptions();
    opts.setStatus("正在转写…");
    try {
      const { warmSpeechEngine } = await import("./speech-models");
      await warmSpeechEngine(engineOptions()).catch(() => false);
      const wav = await current.stop();
      const result = await transcribeRecording(wav, opts.language, engineOptions());
      if (result.ok === false) {
        opts.setStatus(result.message);
        return;
      }
      if (!result.text) {
        opts.setStatus("没有识别到语音");
        return;
      }
      await writeBack(result.text, captured);
      opts.markReady();
      opts.setStatus(null);
    } catch (error) {
      opts.setStatus(recordingErrorMessage(error));
    } finally {
      finishing = false;
    }
  };

  void (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");
      // Subscribe before enabling the OS hook so the first press is not lost.
      unlistenDown = await listen(EVENT_DOWN, () => {
        void onDown();
      });
      unlistenUp = await listen(EVENT_UP, () => {
        void onUp();
      });
      if (disposed) {
        unlistenDown?.();
        unlistenUp?.();
        unlistenDown = null;
        unlistenUp = null;
        return;
      }
      await invoke("voice_ptt_set_enabled", { enabled: true });
      if (disposed) {
        await invoke("voice_ptt_set_enabled", { enabled: false });
        return;
      }
      // Idle: no hint. Status appears only while CapsLock is held / processing.
    } catch (error) {
      const message =
        typeof error === "string"
          ? error
          : error instanceof Error
            ? error.message
            : "无法启用 CapsLock 语音热键";
      getOptions().setStatus(message);
    }
  })();

  return () => {
    disposed = true;
    pressed = false;
    target = null;
    unlistenDown?.();
    unlistenUp?.();
    unlistenDown = null;
    unlistenUp = null;
    void dropRecording();
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("voice_ptt_set_enabled", { enabled: false }))
      .catch(() => undefined);
  };
}
