import { builtinProvider, type ProviderConfig } from "@wb/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAvailableModels } from "./models-list";
import { addProvider, mergeDiscoveredModels, readProviderStore, updateModel } from "./providers";

function provider(): ProviderConfig {
  return {
    ...builtinProvider(),
    id: "custom:probe",
    name: "Probe",
    kind: "openai-chat-completions",
    baseURL: "https://api.openai.com/v1",
    apiKeyRequired: true,
    enabled: true,
    models: { "gpt-4.1": { context: 8192, output: 2048 } },
  };
}

describe("fetchAvailableModels", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("adds models returned by the provider and keeps hand-edited ones", async () => {
    const saved = addProvider({
      name: "OpenAI",
      kind: "openai-chat-completions",
      baseURL: "https://api.openai.com/v1",
      modelId: "gpt-4.1",
      apiKeyRequired: true,
    });
    updateModel(saved.id, "gpt-4.1", { context: 32000, output: 1024 });
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.openai.com/v1/models");
      expect(init?.method).toBe("GET");
      expect(init?.headers).toMatchObject({ authorization: "Bearer sk-test-key-12345678" });
      return new Response(
        JSON.stringify({
          data: [
            { id: "gpt-4.1", context_window: 999 },
            { id: "gpt-4.1-mini", context_window: 128000, max_output_tokens: 4096, vision: true },
          ],
        }),
        { status: 200 },
      );
    });
    const result = await fetchAvailableModels({
      provider: { ...provider(), id: saved.id },
      apiKey: "sk-test-key-12345678",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(mergeDiscoveredModels(saved.id, result.models)).toEqual({ listed: 2, added: 1 });
    const models = readProviderStore().providers.find((item) => item.id === saved.id)?.models;
    expect(models?.["gpt-4.1"]).toEqual({ context: 32000, output: 1024 });
    expect(models?.["gpt-4.1-mini"]).toEqual({
      context: 128000,
      output: 4096,
      inputs: ["image"],
    });
  });

  it("does not call the network when the key is missing", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchAvailableModels({
      provider: provider(),
      apiKey: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ success: false, error: { message: "缺少模型密钥" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
