import { beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_MODEL_REF, BUILTIN_PROVIDER_ID } from "@wb/domain";
import { fetchOcFreeModels, installOcFreeModels } from "./oc-models";
import { readProviderStore } from "./providers";

const catalog = {
  opencode: {
    models: {
      "big-pickle": {
        name: "Big Pickle",
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        limit: { context: 200000, output: 32000 },
        modalities: { input: ["text"], output: ["text"] },
        provider: { api: "https://opencode.ai/inference/openai/v1" },
      },
      paid: {
        name: "Paid",
        cost: { input: 1, output: 1 },
        modalities: { output: ["text"] },
      },
    },
  },
};

describe("OpenCode catalog refresh", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("requests the public catalog and keeps the offline model", async () => {
    const fetchImpl = async (url: string) => {
      expect(url).toBe("https://models.dev/api.json");
      return new Response(JSON.stringify(catalog), { status: 200 });
    };
    const found = await fetchOcFreeModels(fetchImpl);
    installOcFreeModels(found);
    const builtin = readProviderStore().providers.find(
      (item) => item.id === BUILTIN_PROVIDER_ID,
    );
    expect(found.map((model) => model.id)).toEqual(["big-pickle"]);
    expect(builtin?.models.local).toEqual({ context: 8192, output: 2048 });
    expect(builtin?.models["big-pickle"]?.title).toBe("Big Pickle");
    expect(builtin?.models["big-pickle"]?.endpoint).toBe(
      "https://opencode.ai/inference/openai/v1",
    );
  });

  it("falls back to the offline model when the default free model disappears", () => {
    const store = readProviderStore();
    store.defaultModelRef = `${BUILTIN_PROVIDER_ID}/gone`;
    localStorage.setItem("wb.providers.v1", JSON.stringify(store));
    installOcFreeModels([
      {
        id: "big-pickle",
        name: "Big Pickle",
        context: 200000,
        output: 32000,
        image: false,
        endpoint: "https://opencode.ai/inference/openai/v1",
      },
    ]);
    expect(readProviderStore().defaultModelRef).toBe(BUILTIN_MODEL_REF);
  });
});
