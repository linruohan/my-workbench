import { beforeEach, describe, expect, it } from "vitest";
import {
  BUILTIN_MODEL_REF,
  BUILTIN_PROVIDER_ID,
  DSH_CLIENT_UA,
  DSH_FREE_PROVIDER_ID,
} from "@wb/domain";
import { fetchDshFreeModels, installDshFreeModels } from "./dsh-models";
import { readProviderStore } from "./providers";

describe("DSH free catalog", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("requests the inference listing with the free-lane client headers", async () => {
    const found = await fetchDshFreeModels(async (url, init) => {
      expect(url).toBe("https://opencode.ai/inference/v1/models");
      const headers = init?.headers as Record<string, string>;
      expect(headers["user-agent"]).toBe(DSH_CLIENT_UA);
      expect(headers.authorization).toBe("Bearer public");
      expect(headers["x-opencode-session"]).toBe(headers["x-opencode-session-id"]);
      return new Response(
        JSON.stringify({
          data: [{ id: "big-pickle" }, { id: "paid-model" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    expect(found.map((model) => model.id)).toEqual(["big-pickle"]);
  });

  it("replaces the DSH provider models and keeps the builtin default", () => {
    const store = readProviderStore();
    store.defaultModelRef = `${DSH_FREE_PROVIDER_ID}/gone`;
    localStorage.setItem("wb.providers.v1", JSON.stringify(store));
    installDshFreeModels([
      {
        id: "deepseek-v4.1-flash-free",
        name: "DeepSeek V4.1 Flash",
        context: 1_048_576,
        output: 384_000,
        image: true,
      },
    ]);
    const saved = readProviderStore();
    const provider = saved.providers.find((item) => item.id === DSH_FREE_PROVIDER_ID);
    expect(provider?.models["deepseek-v4.1-flash-free"]?.title).toBe(
      "DeepSeek V4.1 Flash",
    );
    expect(provider?.apiKeyRequired).toBe(false);
    expect(saved.providers.some((item) => item.id === BUILTIN_PROVIDER_ID)).toBe(true);
    expect(saved.defaultModelRef).toBe(BUILTIN_MODEL_REF);
  });
});
