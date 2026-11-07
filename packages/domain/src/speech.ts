/** Local SenseVoice (sherpa-onnx) assets used by voice input. */

export const SENSEVOICE_DIR = "models/sensevoice";

export type SenseVoiceFile = {
  name: string;
  /** Relative path under the model root. */
  relPath: string;
  url: string;
  /** Mirror-friendly Hugging Face style URL for China networks. */
  mirrorUrl: string;
  minBytes: number;
  sha256: string;
};

/** Pinned SenseVoiceSmall INT8 + Silero VAD, matching dsh-experimental-speech-to-text-sensevoice. */
export const SENSEVOICE_FILES: readonly SenseVoiceFile[] = [
  {
    name: "model.int8.onnx",
    relPath: "sensevoice-onnx/model.int8.onnx",
    url: "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx",
    mirrorUrl:
      "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx",
    minBytes: 200_000_000,
    sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
  },
  {
    name: "tokens.txt",
    relPath: "sensevoice-onnx/tokens.txt",
    url: "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/tokens.txt",
    mirrorUrl:
      "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/tokens.txt",
    minBytes: 100_000,
    sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc",
  },
  {
    name: "silero_vad.onnx",
    relPath: "silero/silero_vad.onnx",
    url: "https://huggingface.co/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx",
    mirrorUrl:
      "https://hf-mirror.com/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx",
    minBytes: 1_000_000,
    sha256: "a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28",
  },
];

export type SpeechLanguage = "auto" | "zh" | "en" | "yue" | "ja" | "ko";

export const SPEECH_LANGUAGES: readonly { id: SpeechLanguage; label: string }[] = [
  { id: "auto", label: "自动识别" },
  { id: "zh", label: "中文" },
  { id: "en", label: "英语" },
  { id: "yue", label: "粤语" },
  { id: "ja", label: "日语" },
  { id: "ko", label: "韩语" },
];

export const SPEECH_PROVIDER_ID = "sensevoice-local";
export const SPEECH_PROVIDER_NAME = "SenseVoiceSmall (INT8)";

export function missingSenseVoiceFiles(
  present: ReadonlyArray<{ relPath: string; size: number }>,
  files: readonly SenseVoiceFile[] = SENSEVOICE_FILES,
): SenseVoiceFile[] {
  return files.filter((file) => {
    const found = present.find((item) => item.relPath === file.relPath);
    return !found || found.size < file.minBytes;
  });
}

export function isSpeechLanguage(value: string): value is SpeechLanguage {
  return SPEECH_LANGUAGES.some((item) => item.id === value);
}
