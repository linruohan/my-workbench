import type { SpeechLanguage } from "@wb/domain";
import { isTauriRuntime } from "../lib/paths";
import { audioBase64, RecordingError } from "./speech-audio";
import { ensureSenseVoice, warmSenseVoice } from "./speech-models";

export type TranscribeResult =
  | { ok: true; text: string; audioSeconds: number; inferenceSeconds: number }
  | { ok: false; message: string };

type HostTranscript = {
  text: string;
  audioSeconds: number;
  inferenceSeconds: number;
};

export function recordingErrorMessage(error: unknown): string {
  if (error instanceof RecordingError) {
    if (error.kind === "permission") return "需要麦克风权限才能语音输入";
    if (error.kind === "deviceMissing") return "找不到所选麦克风";
    if (error.kind === "empty") return "没有录到有效语音，请再试一次";
    if (error.kind === "cancelled") return "已取消录音";
    if (error.kind === "interrupted") return "麦克风被中断";
    return "当前环境无法录音";
  }
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return "语音输入失败";
}

export async function transcribeRecording(
  wav: Uint8Array,
  language: SpeechLanguage,
): Promise<TranscribeResult> {
  if (!isTauriRuntime()) {
    return { ok: false, message: "语音转写需要在桌面应用中使用" };
  }
  const prepared = await ensureSenseVoice();
  if (prepared.ok === false) {
    return { ok: false, message: prepared.message };
  }
  // Best-effort: if warm finished during recording, the worker is already loaded.
  await warmSenseVoice().catch(() => false);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<HostTranscript>("speech_transcribe", {
      request: {
        audioBase64: audioBase64(wav),
        language,
      },
    });
    return {
      ok: true,
      text: result.text.trim(),
      audioSeconds: result.audioSeconds,
      inferenceSeconds: result.inferenceSeconds,
    };
  } catch (error) {
    return { ok: false, message: recordingErrorMessage(error) };
  }
}

export { Recording, RecordingError } from "./speech-audio";
