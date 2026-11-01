import { beforeEach, describe, expect, it } from "vitest";
import {
  addModel,
  addProvider,
  modelGroups,
  readProviderStore,
  updateProvider,
} from "./providers";

describe("provider menu data", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("groups models under a provider and can append another model id", () => {
    const provider = addProvider({
      name: "Ollama",
      kind: "openai-chat-completions",
      baseURL: "http://127.0.0.1:11434/v1",
      modelId: "llama3.1",
      apiKeyRequired: false,
    });
    expect(addModel(provider.id, "qwen2.5")).toBe(`${provider.id}/qwen2.5`);
    expect(addModel(provider.id, "bad/id")).toBeNull();
    const group = modelGroups().find((item) => item.id === provider.id);
    expect(group?.models.map((model) => model.id)).toEqual(["llama3.1", "qwen2.5"]);
    expect(JSON.stringify(readProviderStore())).not.toContain("sk-");
  });

  it("updates a provider name and address without storing a key", () => {
    const provider = addProvider({
      name: "Ollama",
      kind: "openai-chat-completions",
      baseURL: "http://127.0.0.1:11434/v1",
      modelId: "llama3.1",
      apiKeyRequired: false,
    });
    expect(
      updateProvider(provider.id, {
        name: "本机 Ollama",
        baseURL: "http://127.0.0.1:11434/v1/",
        apiKeyRequired: true,
      }),
    ).toBe(true);
    const saved = readProviderStore().providers.find((item) => item.id === provider.id);
    expect(saved?.name).toBe("本机 Ollama");
    expect(saved?.baseURL).toBe("http://127.0.0.1:11434/v1");
    expect(saved?.apiKeyRequired).toBe(true);
    expect(saved?.models["llama3.1"]).toBeTruthy();
  });
});
