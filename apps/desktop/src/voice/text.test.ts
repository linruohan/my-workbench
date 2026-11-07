import { describe, expect, it } from "vitest";
import { appendVoiceText, insertVoiceText } from "./text";
import { resampleTo16k } from "./speech-audio";

describe("insertVoiceText", () => {
  it("appends with a separating space", () => {
    expect(appendVoiceText("你好", "世界")).toBe("你好 世界");
  });

  it("inserts at the caret and restores the next caret", () => {
    const result = insertVoiceText("你好世界", "中间", 2);
    expect(result.value).toBe("你好 中间 世界");
    expect(result.caret).toBe("你好 中间".length);
  });

  it("avoids double spaces near punctuation", () => {
    expect(appendVoiceText("你好（", "内容")).toBe("你好（内容");
  });
});

describe("resampleTo16k", () => {
  it("keeps 16 kHz samples unchanged", () => {
    const input = new Float32Array([0, 0.5, -0.5, 1]);
    const out = resampleTo16k(input, 16_000);
    expect([...out]).toEqual([...input]);
  });

  it("downsamples 48 kHz to about one third length", () => {
    const input = new Float32Array(480);
    for (let i = 0; i < input.length; i += 1) input[i] = Math.sin(i / 10);
    const out = resampleTo16k(input, 48_000);
    expect(out.length).toBe(160);
  });
});
