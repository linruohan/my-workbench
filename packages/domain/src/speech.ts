/** Local speech engines: models live under AppData/my-workbench/models/<engine>. */

export const SENSEVOICE_DIR = "models/sensevoice";
export const FUNASR_DIR = "models/funasr";
export const QWENCTC_DIR = "models/qwenctc";

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

export type SpeechArchiveSpec = {
  name: string;
  /** Relative extract root under the engine model directory. */
  relDir: string;
  url: string;
  mirrorUrl: string;
  minBytes: number;
  /** Marker files that must exist after extract. */
  markers: readonly string[];
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

/** CapsWriter Fun-ASR-Nano-GGUF pack (GitHub Release). Extracted into models/funasr. */
export const FUNASR_ARCHIVE: SpeechArchiveSpec = {
  name: "Fun-ASR-Nano-GGUF.zip",
  relDir: "",
  url: "https://github.com/HaujetZhao/CapsWriter-Offline/releases/download/models/Fun-ASR-Nano-GGUF.zip",
  mirrorUrl:
    "https://ghfast.top/https://github.com/HaujetZhao/CapsWriter-Offline/releases/download/models/Fun-ASR-Nano-GGUF.zip",
  minBytes: 700_000_000,
  markers: [
    "Fun-ASR-Nano-Encoder-Adaptor.fp16.onnx",
    "Fun-ASR-Nano-CTC.fp16.onnx",
    "Fun-ASR-Nano-Decoder.q5_k.gguf",
    "tokens.txt",
  ],
};

/**
 * QwenCTC weights under AppData/models/qwenctc.
 * CTC head: qwen-ctc-a7avg5 (preferred). Encoder / tokens / preprocessor: qwen-ctc.
 * Bundled sidecar assets remain a fallback via ensure copy.
 */
export const QWENCTC_FILES: readonly SenseVoiceFile[] = [
  {
    name: "Qwen3-ASR-CTC.fp16.onnx",
    relPath: "Qwen3-ASR-CTC.fp16.onnx",
    url: "https://huggingface.co/JazerJu/glm-asr-ctc-bench/resolve/main/qwen-ctc-a7avg5/Qwen3-ASR-CTC.fp16.onnx",
    mirrorUrl:
      "https://hf-mirror.com/JazerJu/glm-asr-ctc-bench/resolve/main/qwen-ctc-a7avg5/Qwen3-ASR-CTC.fp16.onnx",
    minBytes: 160_000_000,
    sha256: "e1a12c21a2675fcaad81ea25a19c3123c9a0ad63b5b71f9e8bdb9ca566c6105d",
  },
  {
    name: "Qwen3-ASR-Encoder.q4.onnx",
    relPath: "Qwen3-ASR-Encoder.q4.onnx",
    url: "https://huggingface.co/JazerJu/glm-asr-ctc-bench/resolve/main/qwen-ctc/Qwen3-ASR-Encoder.q4.onnx",
    mirrorUrl:
      "https://hf-mirror.com/JazerJu/glm-asr-ctc-bench/resolve/main/qwen-ctc/Qwen3-ASR-Encoder.q4.onnx",
    minBytes: 160_000_000,
    sha256: "23a3ae24a20fb278da2b4a72d2210602499739f270c7a394c012f24f8f99ed4f",
  },
  {
    name: "tokens.txt",
    relPath: "tokens.txt",
    url: "https://huggingface.co/JazerJu/glm-asr-ctc-bench/resolve/main/qwen-ctc/tokens.txt",
    mirrorUrl:
      "https://hf-mirror.com/JazerJu/glm-asr-ctc-bench/resolve/main/qwen-ctc/tokens.txt",
    minBytes: 1_000_000,
    sha256: "398d85aa68f9e49335ef933672f31fe0a107fdf7ab35568cd2172ec93952b98e",
  },
  {
    name: "preprocessor_config.json",
    relPath: "preprocessor_config.json",
    url: "https://huggingface.co/JazerJu/glm-asr-ctc-bench/resolve/main/qwen-ctc/preprocessor_config.json",
    mirrorUrl:
      "https://hf-mirror.com/JazerJu/glm-asr-ctc-bench/resolve/main/qwen-ctc/preprocessor_config.json",
    minBytes: 200,
    sha256: "45e120a4eda2c20c5d7f2ea9354e63536bf35e27aa573fb7cdf78017b378770d",
  },
];

/** llama.cpp runtime DLLs for FunASR / QwenCTC (Windows x64, CapsWriter-compatible build). */
export const LLAMA_BIN_ARCHIVE: SpeechArchiveSpec = {
  name: "llama-b11675-bin-win-vulkan-x64.zip",
  relDir: "bin",
  url: "https://github.com/ggml-org/llama.cpp/releases/download/b11675/llama-b11675-bin-win-vulkan-x64.zip",
  mirrorUrl:
    "https://ghfast.top/https://github.com/ggml-org/llama.cpp/releases/download/b11675/llama-b11675-bin-win-vulkan-x64.zip",
  minBytes: 20_000_000,
  markers: ["llama.dll", "ggml-base.dll"],
};

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

export type SpeechEngineId = "sensevoice" | "funasr" | "qwenctc";

export const SPEECH_ENGINES: readonly {
  id: SpeechEngineId;
  label: string;
  hint: string;
}[] = [
  {
    id: "sensevoice",
    label: "SenseVoiceSmall (INT8)",
    hint: "轻量本机识别，启动快；缺失时需在设置中手动准备",
  },
  {
    id: "funasr",
    label: "Fun-ASR-Nano-GGUF",
    hint: "准确率更高；约 800MB，缺失时需在设置中手动准备",
  },
  {
    id: "qwenctc",
    label: "QwenCTC (Qwen3-ASR)",
    hint: "中英混说纯 CTC；缺失时需在设置中手动准备",
  },
];

export function speechEngineModelSubdir(engine: SpeechEngineId): string {
  if (engine === "funasr") return "funasr";
  if (engine === "qwenctc") return "qwenctc";
  return "sensevoice";
}

export function isSpeechEngineId(value: string): value is SpeechEngineId {
  return SPEECH_ENGINES.some((item) => item.id === value);
}

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

/** Human-readable missing-model guide with download links for the selected engine. */
export function speechEngineDownloadGuide(
  engine: SpeechEngineId,
  modelDir?: string,
): string {
  const sub = speechEngineModelSubdir(engine);
  const dir = modelDir?.trim() || `%APPDATA%\\my-workbench\\models\\${sub}`;
  const lines = [
    "请先下载模型文件后再使用语音输入。",
    `目标目录：${dir}`,
    "也可在「设置 → 语音输入」点击「开始准备」自动下载。",
    "",
  ];
  if (engine === "funasr") {
    lines.push(
      "Fun-ASR-Nano-GGUF（约 800MB）：",
      FUNASR_ARCHIVE.url,
      `镜像：${FUNASR_ARCHIVE.mirrorUrl}`,
      "",
      "llama 运行库：",
      LLAMA_BIN_ARCHIVE.url,
      `镜像：${LLAMA_BIN_ARCHIVE.mirrorUrl}`,
      "解压后将 llama.dll 等放到上述目录的 bin\\ 下。",
    );
  } else if (engine === "qwenctc") {
    lines.push(
      "来源：Hugging Face JazerJu/glm-asr-ctc-bench",
      "CTC 头目录：qwen-ctc-a7avg5；编码器与词表：qwen-ctc",
      "",
    );
    for (const file of QWENCTC_FILES) {
      lines.push(`${file.name}：`, file.url, `镜像：${file.mirrorUrl}`, "");
    }
    lines.push(
      "llama 运行库：",
      LLAMA_BIN_ARCHIVE.url,
      `镜像：${LLAMA_BIN_ARCHIVE.mirrorUrl}`,
      "解压后将 llama.dll 等放到上述目录的 bin\\ 下。",
    );
  } else {
    for (const file of SENSEVOICE_FILES) {
      lines.push(`${file.name}：`, file.url, `镜像：${file.mirrorUrl}`, "");
    }
  }
  return lines.join("\n").trim();
}
