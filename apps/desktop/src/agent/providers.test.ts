import { beforeEach, describe, expect, it } from "vitest";
import {
  addModel,
  addProvider,
  addProviderFromTemplate,
  modelGroups,
  readProviderStore,
  removeModel,
  updateModel,
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

  it("creates a blank provider and manages model caps", () => {
    const blank = addProvider({
      name: "新供应商",
      kind: "openai-chat-completions",
      baseURL: "https://api.example.com/v1",
      modelId: "",
      apiKeyRequired: true,
    });
    expect(Object.keys(blank.models)).toEqual([]);
    const fromTemplate = addProviderFromTemplate("deepseek");
    expect(fromTemplate?.name).toBe("DeepSeek");
    expect(fromTemplate?.models["deepseek-chat"]).toBeTruthy();
    const provider = addProvider({
      name: "Caps",
      kind: "openai-chat-completions",
      baseURL: "http://127.0.0.1:11434/v1",
      modelId: "a",
      apiKeyRequired: false,
    });
    expect(addModel(provider.id, "b")).toBe(`${provider.id}/b`);
    expect(updateModel(provider.id, "b", { context: 32000, output: 4096 })).toBe(true);
    expect(removeModel(provider.id, "a")).toBe(true);
    expect(removeModel(provider.id, "b")).toBe(false);
    const saved = readProviderStore().providers.find((item) => item.id === provider.id);
    expect(saved?.models.b).toEqual({ context: 32000, output: 4096 });
  });
});
