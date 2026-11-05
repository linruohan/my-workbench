import { describe, expect, it } from "vitest";
import { buildModelHttpRequest, builtinProvider } from "../src/index.js";
import {
  argmaxRows,
  boxesFromMap,
  ctcDecode,
  detInputSize,
  imageOnlyCaption,
  localOcrReply,
  localOcrTurn,
  localOcrUserMessage,
  missingPaddleOcrFiles,
  modelCanSeeImages,
  PADDLEOCR_FILES,
  parseOcrKeys,
  pixelsToNchw,
  selectOcrBoxes,
  withLocalOcrContext,
} from "../src/paddleocr.js";

describe("paddleocr", () => {
  it("keeps a file only when it is at least the expected size", () => {
    const present = PADDLEOCR_FILES.map((file) => ({
      name: file.name,
      size: file.name.endsWith(".txt") ? 100 : file.minBytes,
    }));
    const missing = missingPaddleOcrFiles(present);
    expect(missing.map((file) => file.name)).toEqual(["ppocrv6_dict.txt"]);
  });

  it("treats only chat and anthropic image models as visual", () => {
    expect(modelCanSeeImages("builtin", { inputs: ["image"] })).toBe(false);
    expect(modelCanSeeImages("openai-responses", { inputs: ["image"] })).toBe(false);
    expect(modelCanSeeImages("openai-chat-completions", {})).toBe(false);
    expect(modelCanSeeImages("openai-chat-completions", { inputs: ["image"] })).toBe(
      true,
    );
    expect(modelCanSeeImages("anthropic-messages", { inputs: ["image"] })).toBe(true);
  });

  it("formats recognition as the reply, or as context for a text question", () => {
    expect(localOcrReply([" 你好 ", ""])).toBe("你好");
    expect(localOcrReply(["  "])).toBe("没有识别到文字。");
    expect(imageOnlyCaption(" a.png ")).toBe("[图片] a.png");
    expect(localOcrUserMessage("识别图片", "shot.png")).toBe(
      "识别图片\n\n[图片] shot.png",
    );
    expect(localOcrUserMessage("  ", "a.png")).toBe("[图片] a.png");
    expect(localOcrTurn("识别图片", "shot.png", ["会议纪要", ""])).toEqual({
      user: "识别图片\n\n[图片] shot.png",
      assistant: "会议纪要",
    });
    expect(localOcrTurn("  ", "a.png", ["  "])).toEqual({
      user: "[图片] a.png",
      assistant: "没有识别到文字。",
    });
    expect(withLocalOcrContext("这是什么", ["发票"])).toContain("发票");
    expect(withLocalOcrContext("这是什么", ["发票"])).toContain("这是什么");
    expect(withLocalOcrContext("这是什么", ["发票"])).not.toBe(
      localOcrUserMessage("这是什么", "a.png"),
    );
  });

  it("decodes CTC and drops repeated classes", () => {
    const keys = parseOcrKeys("你\n好\n");
    expect(ctcDecode([0, 1, 1, 0, 2], keys)).toBe("你好");
    expect(argmaxRows([0.1, 0.9, 0.2, 0.8], 2, 2)).toEqual([1, 1]);
  });

  it("finds a text blob and snaps the detection size", () => {
    const width = 8;
    const height = 8;
    const map = new Float32Array(width * height);
    for (let y = 2; y <= 4; y += 1) {
      for (let x = 1; x <= 5; x += 1) map[y * width + x] = 0.9;
    }
    const boxes = selectOcrBoxes(boxesFromMap(map, width, height));
    expect(boxes).toEqual([{ x: 1, y: 2, w: 5, h: 3 }]);
    expect(detInputSize(100, 50).width % 32).toBe(0);
    const white = pixelsToNchw([255, 255, 255, 255], 1, 1);
    expect(white[0]).toBeCloseTo(1);
  });

  it("attaches an image only to the latest user message", () => {
    const provider = {
      ...builtinProvider(),
      id: "vision",
      name: "Vision",
      kind: "openai-chat-completions" as const,
      baseURL: "https://example.com/v1",
      apiKeyRequired: true,
      models: { see: { context: 8192, output: 2048, inputs: ["image" as const] } },
    };
    const request = buildModelHttpRequest({
      provider,
      modelId: "see",
      system: "system",
      messages: [
        {
          id: "u1",
          threadId: "t",
          role: "user",
          content: "先看文字",
          toolName: null,
          toolCallId: null,
          toolCallsJson: null,
          createdAt: 1,
        },
        {
          id: "u2",
          threadId: "t",
          role: "user",
          content: "看这张图",
          toolName: null,
          toolCallId: null,
          toolCallsJson: null,
          createdAt: 2,
        },
      ],
      permissionMode: "confirm",
      imageDataUrl: "data:image/jpeg;base64,aaaa",
    });
    const body = request.body as { messages: Array<{ content: unknown }> };
    expect(body.messages[1]?.content).toBe("先看文字");
    expect(JSON.stringify(body.messages[2]?.content)).toContain("image_url");
    expect(JSON.stringify(body.messages[2]?.content)).toContain("看这张图");
  });
});
