import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { renderWithProviders } from "../test/render";
import { ModelsPane } from "./ModelsPane";
import { addProvider, readProviderStore } from "./providers";

afterEach(() => {
  cleanup();
  localStorage.clear();
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
});
