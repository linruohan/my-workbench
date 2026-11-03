import { describe, expect, it } from "vitest";
import { modelsListUrl, parseAvailableModels } from "../src/models-list.js";

describe("available models", () => {
  it("builds the models index for each API format", () => {
    expect(
      modelsListUrl({
        kind: "openai-chat-completions",
        baseURL: "https://api.openai.com/v1/",
      }),
    ).toBe("https://api.openai.com/v1/models");
    expect(
      modelsListUrl({
        kind: "openai-responses",
        baseURL: "https://api.openai.com/v1/responses",
      }),
    ).toBe("https://api.openai.com/v1/models");
    expect(
      modelsListUrl({ kind: "anthropic-messages", baseURL: "https://api.anthropic.com" }),
    ).toBe("https://api.anthropic.com/v1/models");
  });

  it("reads ids, limits, and image support, and skips unsafe ids", () => {
    const models = parseAvailableModels({
      data: [
        { id: "gpt-4.1" },
        {
          id: "gpt-4.1-mini",
          context_window: 128000,
          max_output_tokens: 4096,
          vision: true,
        },
        { id: "org/hidden" },
        { id: "gpt-4.1" },
        { name: "llama3.1", context_length: "8192" },
      ],
    });
    expect(models).toEqual([
      { id: "gpt-4.1" },
      { id: "gpt-4.1-mini", context: 128000, output: 4096, image: true },
      { id: "llama3.1", context: 8192 },
    ]);
  });
});
