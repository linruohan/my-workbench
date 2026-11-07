import { describe, expect, it } from "vitest";
import {
  appendVoiceText,
  injectVoiceIntoEditable,
  injectVoiceIntoField,
  insertVoiceText,
  isVoiceEditable,
  VOICE_HOLD_MIN_MS,
} from "./text";
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

  it("keeps CapsWriter-style short-press threshold at 500ms", () => {
    expect(VOICE_HOLD_MIN_MS).toBe(500);
  });
});

describe("injectVoiceIntoField", () => {
  it("writes into a textarea and keeps caret after the spoken chunk", () => {
    const area = document.createElement("textarea");
    area.value = "你好世界";
    document.body.appendChild(area);
    Object.defineProperty(area, "selectionStart", {
      configurable: true,
      get: () => 2,
      set: () => undefined,
    });
    Object.defineProperty(area, "selectionEnd", {
      configurable: true,
      get: () => 2,
      set: () => undefined,
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => false,
    });

    const result = injectVoiceIntoField(area, "中间");
    expect(result.value).toBe("你好 中间 世界");
    expect(area.value).toBe("你好 中间 世界");

    area.remove();
  });

  it("treats textareas and contenteditable as voice targets", () => {
    const area = document.createElement("textarea");
    const div = document.createElement("div");
    Object.defineProperty(div, "isContentEditable", {
      configurable: true,
      value: true,
    });
    expect(isVoiceEditable(area)).toBe(true);
    expect(isVoiceEditable(div)).toBe(true);
    expect(isVoiceEditable(document.createElement("button"))).toBe(false);
  });

  it("injects into contenteditable via insertText", () => {
    const div = document.createElement("div");
    Object.defineProperty(div, "isContentEditable", {
      configurable: true,
      value: true,
    });
    document.body.appendChild(div);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => true,
    });
    expect(injectVoiceIntoEditable(div, "你好")).toBe(true);
    div.remove();
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
