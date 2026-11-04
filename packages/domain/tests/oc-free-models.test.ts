import { describe, expect, it } from "vitest";
import {
  buildOcRunPrompt,
  mergeBuiltinModels,
  readOcRunOutput,
  resolveOcApiKey,
  selectOcFreeModels,
} from "../src/oc-free-models";

describe("OpenCode free models", () => {
  it("keeps only zero-cost text models from the live catalog", () => {
    const found = selectOcFreeModels({
      opencode: {
        api: "https://opencode.ai/inference/openai/v1",
        models: {
          "big-pickle": {
            name: "Big Pickle",
            cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
            limit: { context: 200000, output: 32000 },
            modalities: { input: ["text"], output: ["text"] },
            provider: { api: "https://opencode.ai/inference/openai/v1" },
          },
          "paid-output": {
            name: "Paid",
            cost: { input: 0, output: 1, cache_read: 0, cache_write: 0 },
            modalities: { output: ["text"] },
          },
          cached: {
            name: "Cached",
            cost: { input: 0, output: 0, cache_read: 1, cache_write: 0 },
            modalities: { output: ["text"] },
          },
          omitted: {
            name: "No Price",
            modalities: { output: ["text"] },
          },
          dead: {
            name: "Dead",
            status: "deprecated",
            cost: { input: 0, output: 0 },
            modalities: { output: ["text"] },
          },
          picture: {
            name: "Picture",
            cost: { input: 0, output: 0 },
            modalities: { output: ["image"] },
          },
        },
      },
    });
    expect(found.map((model) => model.id)).toEqual(["big-pickle"]);
    expect(found[0]).toMatchObject({
      name: "Big Pickle",
      context: 200000,
      output: 32000,
      image: false,
      endpoint: "https://opencode.ai/inference/openai/v1",
    });
  });

  it("uses the ferry provider list and drops slash ids", () => {
    const found = selectOcFreeModels({
      all: [
        {
          id: "opencode",
          models: {
            free: {
              name: "Free One",
              cost: { input: 0, output: 0 },
              capabilities: {
                output: { text: true },
                input: { image: true },
              },
              limit: { context: 1000, output: 500 },
            },
            "org/hidden": {
              name: "Hidden",
              cost: { input: 0, output: 0 },
              capabilities: { output: { text: true } },
            },
          },
        },
      ],
    });
    expect(found.map((model) => model.id)).toEqual(["free"]);
    expect(found[0]?.image).toBe(true);
  });

  it("keeps the offline local model when the catalog is merged", () => {
    const models = mergeBuiltinModels(
      {
        local: { context: 8192, output: 2048 },
        "old-free": { context: 1, output: 1, endpoint: "https://old.example/v1" },
      },
      [
        {
          id: "big-pickle",
          name: "Big Pickle",
          context: 200000,
          output: 32000,
          image: true,
          endpoint: "https://opencode.ai/inference/openai/v1",
        },
      ],
    );
    expect(Object.keys(models)).toEqual(["local", "big-pickle"]);
    expect(models.local).toEqual({ context: 8192, output: 2048 });
    expect(models["big-pickle"]?.title).toBe("Big Pickle");
    expect(models["big-pickle"]?.inputs).toEqual(["image"]);
  });

  it("reads the live OpenCode model list, including array prices", () => {
    const found = selectOcFreeModels({
      data: [
        {
          id: "glm-5.3-flash-free",
          providerID: "opencode",
          name: "GLM-5.3-Flash Free",
          status: "active",
          cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
          limit: { context: 200000, output: 32000 },
          capabilities: { input: ["text"], output: ["text"] },
          settings: { baseURL: "https://opencode.ai/inference/openai/v1" },
        },
        {
          id: "paid-one",
          providerID: "opencode",
          name: "Paid",
          cost: [{ input: 1, output: 1, cache: { read: 0, write: 0 } }],
          capabilities: { output: ["text"] },
        },
        {
          id: "other",
          providerID: "openai",
          name: "Other",
          cost: [{ input: 0, output: 0 }],
          capabilities: { output: ["text"] },
        },
      ],
    });
    expect(found.map((model) => model.id)).toEqual(["glm-5.3-flash-free"]);
    expect(found[0]?.endpoint).toBe("https://opencode.ai/inference/openai/v1");
  });

  it("uses the public key unless one is saved", () => {
    expect(resolveOcApiKey(null)).toBe("public");
    expect(resolveOcApiKey("  sk-user  ")).toBe("sk-user");
  });

  it("reads an OpenCode run transcript and keeps the prompt bounded", () => {
    expect(
      readOcRunOutput(
        '{"type":"text","part":{"type":"text","text":"pong"}}\n{"type":"step_finish","part":{"reason":"stop"}}\n',
      ),
    ).toEqual({ ok: true, text: "pong" });
    expect(
      readOcRunOutput(
        '{"type":"error","error":{"message":"Free usage limit reached."}}\n',
      ),
    ).toEqual({
      ok: false,
      message: "OpenCode 免费额度已用完。可在设置里接入自己的模型供应商",
    });
    expect(
      readOcRunOutput(
        '{"type":"error","error":{"type":"provider.free-limit","message":"Free usage limit reached.","retryAfterMs":33840000}}\n',
      ),
    ).toEqual({
      ok: false,
      message:
        "OpenCode 免费额度已用完，大约 9 小时后恢复。可在设置里接入自己的模型供应商",
    });
    const prompt = buildOcRunPrompt({
      system: "sys",
      messages: [{ role: "user", content: "x".repeat(20_100) }],
    });
    expect(prompt.length).toBe(20_000);
    expect(prompt.endsWith("x")).toBe(true);
  });
});
