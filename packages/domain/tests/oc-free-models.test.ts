import { describe, expect, it } from "vitest";
import { mergeBuiltinModels, selectOcFreeModels } from "../src/oc-free-models";

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
});
