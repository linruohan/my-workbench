import { builtinProvider, dshFreeProvider, type ProviderConfig } from "@wb/domain";
import { describe, expect, it, vi } from "vitest";
import { testModelConnectivity } from "./connectivity";

function provider(patch: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    ...builtinProvider(),
    id: "custom:probe",
    name: "Probe",
    kind: "openai-chat-completions",
    baseURL: "https://probe.invalid/v1",
    apiKeyRequired: true,
    enabled: true,
    models: { "probe-model": { context: 8192, output: 2048 } },
    ...patch,
  };
}

describe("testModelConnectivity", () => {
  it("succeeds when the stream finishes and sends the probe body", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        tools?: unknown;
        max_completion_tokens?: number;
      };
      expect(body.tools).toBeUndefined();
      expect(body.max_completion_tokens).toBe(1);
      expect(init?.headers).toMatchObject({
        authorization: "Bearer sk-test-key-12345678",
      });
      return new Response(
        [
          'data: {"choices":[{"delta":{"content":"h"},"finish_reason":null}]}',
          "",
          'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const result = await testModelConnectivity({
      provider: provider(),
      modelId: "probe-model",
      apiKey: "sk-test-key-12345678",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ success: true });
  });

  it("fails when the stream ends before finish", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        'data: {"choices":[{"delta":{"content":"h"},"finish_reason":null}]}\n\n',
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    });
    const result = await testModelConnectivity({
      provider: provider(),
      modelId: "probe-model",
      apiKey: "sk-test-key-12345678",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({
      success: false,
      error: { message: "连接测试在结束前中断" },
    });
  });

  it("classifies auth failures and skips the network when the key is missing", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ error: { message: "bad key" } }), {
        status: 401,
      });
    });
    const denied = await testModelConnectivity({
      provider: provider(),
      modelId: "probe-model",
      apiKey: "sk-test-key-12345678",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(denied).toEqual({ success: false, error: { message: "认证失败" } });

    const balance = await testModelConnectivity({
      provider: provider(),
      modelId: "probe-model",
      apiKey: "sk-test-key-12345678",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            error: {
              message:
                "Insufficient Balance (request_id: d923ad94-94a4-4cc3-8ac4-d46da4af7365)",
              type: "insufficient_balance_error",
              code: "invalid_request_error",
            },
          }),
          { status: 402 },
        )) as typeof fetch,
    });
    expect(balance).toEqual({ success: false, error: { message: "余额不足" } });

    const missing = await testModelConnectivity({
      provider: provider(),
      modelId: "probe-model",
      apiKey: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(missing).toEqual({ success: false, error: { message: "缺少模型密钥" } });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("calls a builtin free model with OpenCode's public key", async () => {
    const builtin = builtinProvider();
    builtin.models["big-pickle"] = {
      context: 8192,
      output: 2048,
      endpoint: "https://opencode.ai/inference/openai/v1",
    };
    let authorization = "";
    const result = await testModelConnectivity({
      provider: builtin,
      modelId: "big-pickle",
      apiKey: null,
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        authorization = headers.get("authorization") ?? "";
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "pong" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    expect(result).toEqual({ success: true });
    expect(authorization).toBe("Bearer public");
  });

  it("sends a DSH free model through the free-lane chat endpoint", async () => {
    const provider = dshFreeProvider({
      "deepseek-v4.1-flash-free": {
        context: 8192,
        output: 2048,
        title: "DeepSeek V4.1 Flash",
      },
    });
    let sentUrl = "";
    let userAgent = "";
    const result = await testModelConnectivity({
      provider,
      modelId: "deepseek-v4.1-flash-free",
      apiKey: "sk-should-not-be-sent",
      fetchImpl: (async (url: string, init?: RequestInit) => {
        sentUrl = url;
        const headers = init?.headers as Record<string, string>;
        userAgent = headers["user-agent"] ?? "";
        expect(headers.authorization).toBe("Bearer public");
        expect(JSON.stringify(init?.headers)).not.toContain("sk-should-not-be-sent");
        const body = JSON.parse(String(init?.body)) as {
          tools?: Array<{ function: { name: string } }>;
        };
        expect(body.tools?.map((tool) => tool.function.name)).toEqual(["read", "shell"]);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "pong" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    expect(result).toEqual({ success: true });
    expect(sentUrl).toBe("https://opencode.ai/inference/v1/chat/completions");
    expect(userAgent).toBe("opencode/latest/2.0.26/cli");
  });
});
