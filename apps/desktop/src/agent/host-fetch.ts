import { readPrefs } from "../lib/prefs";
import { isTauriRuntime } from "../lib/paths";

type HostResponse = {
  status: number;
  contentType?: string;
  content_type?: string;
  body: string;
};

/** Provider HTTP. The desktop host sends it so the page origin cannot block the call. */
export async function hostFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  if (!isTauriRuntime()) return fetch(url, init);
  if (init.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
  const { invoke } = await import("@tauri-apps/api/core");
  const proxy = readPrefs().httpProxy.trim();
  let result: HostResponse;
  try {
    result = await invoke<HostResponse>("model_http", {
      method: init.method ?? "GET",
      url,
      headers: headersToRecord(init.headers),
      body: typeof init.body === "string" ? init.body : null,
      timeoutMs: init.timeoutMs ?? 60_000,
      proxy: proxy || null,
    });
  } catch (error) {
    const message =
      typeof error === "string"
        ? error.trim()
        : error instanceof Error
          ? error.message.trim()
          : "";
    throw new Error(message || "网络错误");
  }
  const contentType = result.contentType || result.content_type || "application/octet-stream";
  return new Response(result.body, {
    status: result.status,
    headers: { "content-type": contentType },
  });
}

export function describeTransportError(error: unknown, timeoutLabel: string): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message.trim() : "";
  if (name === "TimeoutError" || name === "AbortError" || message === "测试超时" || /超时/.test(message)) {
    return timeoutLabel;
  }
  if (message && message !== "Failed to fetch") return message.slice(0, 200);
  return "网络错误";
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}
