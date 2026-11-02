import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/render";
import { writeCredential } from "./credentials";
import { ModelsPane } from "./ModelsPane";
import { addProvider, readProviderStore } from "./providers";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("model API format", () => {
  it("lists the three formats and saves Responses", async () => {
    const user = userEvent.setup();
    const provider = addProvider({
      name: "OpenAI",
      kind: "openai-chat-completions",
      baseURL: "https://api.openai.com/v1",
      modelId: "gpt-4.1",
      apiKeyRequired: true,
    });
    renderWithProviders(<ModelsPane />);

    await user.click(screen.getByRole("button", { name: "API 格式" }));
    expect(
      screen.getByRole("option", { name: "Anthropic Messages (/v1/messages)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Chat Completions (/chat/completions)" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Responses (/responses)" }));

    const saved = readProviderStore().providers.find((item) => item.id === provider.id);
    expect(saved?.kind).toBe("openai-responses");
    expect(screen.getByRole("button", { name: "API 格式" })).toHaveTextContent(
      "Responses (/responses)",
    );
  });

  it("adds a model from the dialog", async () => {
    const user = userEvent.setup();
    const provider = addProvider({
      name: "OpenAI",
      kind: "openai-chat-completions",
      baseURL: "https://api.openai.com/v1",
      modelId: "",
      apiKeyRequired: true,
    });
    renderWithProviders(<ModelsPane />);

    await user.click(screen.getByRole("button", { name: "添加模型" }));
    expect(screen.getByRole("dialog", { name: "添加模型" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "智能配置" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "文本" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "上下文窗口" })).toBeDisabled();

    await user.type(screen.getByRole("textbox", { name: "模型 ID" }), "gpt-4.1");
    await user.click(screen.getByRole("checkbox", { name: "图片" }));
    await user.click(screen.getByRole("button", { name: "保存" }));

    const saved = readProviderStore().providers.find((item) => item.id === provider.id);
    expect(saved?.models["gpt-4.1"]).toMatchObject({
      smart: true,
      context: 8192,
      output: 2048,
      inputs: ["image"],
    });
    expect(screen.queryByRole("dialog", { name: "添加模型" })).not.toBeInTheDocument();
  });

  it("tests a model from the list", async () => {
    const user = userEvent.setup();
    const provider = addProvider({
      name: "OpenAI",
      kind: "openai-chat-completions",
      baseURL: "https://api.openai.com/v1",
      modelId: "gpt-4.1",
      apiKeyRequired: true,
    });
    writeCredential(provider.id, "sk-test-key-12345678");
    const fetchMock = vi.fn(
      async () =>
        new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderWithProviders(<ModelsPane />);

    await user.click(screen.getByRole("button", { name: "测试模型 gpt-4.1" }));
    expect(await screen.findByText("OpenAI / gpt-4.1 连接成功")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
