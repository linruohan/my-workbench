import { describe, expect, it } from "vitest";
import {
  isSpeechEngineId,
  isSpeechLanguage,
  missingSenseVoiceFiles,
  SENSEVOICE_FILES,
  SPEECH_ENGINES,
  SPEECH_LANGUAGES,
} from "../src/speech.js";

describe("speech", () => {
  it("lists the pinned SenseVoice INT8 assets", () => {
    expect(SENSEVOICE_FILES.map((file) => file.name)).toEqual([
      "model.int8.onnx",
      "tokens.txt",
      "silero_vad.onnx",
    ]);
  });

  it("keeps a file only when it is at least the expected size", () => {
    const present = SENSEVOICE_FILES.map((file) => ({
      relPath: file.relPath,
      size: file.name.endsWith(".txt") ? 100 : file.minBytes,
    }));
    const missing = missingSenseVoiceFiles(present);
    expect(missing.map((file) => file.name)).toEqual(["tokens.txt"]);
  });

  it("accepts only known language hints", () => {
    expect(isSpeechLanguage("auto")).toBe(true);
    expect(isSpeechLanguage("zh")).toBe(true);
    expect(isSpeechLanguage("fr")).toBe(false);
    expect(SPEECH_LANGUAGES.some((item) => item.id === "yue")).toBe(true);
  });

  it("lists SenseVoice, FunASR and QwenCTC engines", () => {
    expect(SPEECH_ENGINES.map((item) => item.id)).toEqual([
      "sensevoice",
      "funasr",
      "qwenctc",
    ]);
    expect(isSpeechEngineId("funasr")).toBe(true);
    expect(isSpeechEngineId("qwenctc")).toBe(true);
    expect(isSpeechEngineId("whisper")).toBe(false);
  });
});
