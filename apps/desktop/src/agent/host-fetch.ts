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
  if (init.signal?.aborted)
    throw new DOMException("The operation was aborted.", "AbortError");
  const { invoke } = await import("@tauri-apps/api/core");
  const proxy = readPrefs().httpProxy.trim();
  let result: HostResponse;
  try {
    const invokePromise = invoke<HostResponse>("model_http", {
      method: init.method ?? "GET",
      url,
      headers: headersToRecord(init.headers),
      body: typeof init.body === "string" ? init.body : null,
      timeoutMs: init.timeoutMs ?? 60_000,
      proxy: proxy || null,
    });
    result = init.signal
      ? await raceAbort(invokePromise, init.signal)
      : await invokePromise;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (error instanceof Error && error.name === "AbortError") throw error;
    const message =
      typeof error === "string"
        ? error.trim()
        : error instanceof Error
          ? error.message.trim()
          : "";
    throw new Error(message || "网络错误");
  }
  if (init.signal?.aborted)
    throw new DOMException("The operation was aborted.", "AbortError");
  const contentType =
    result.contentType || result.content_type || "application/octet-stream";
  return new Response(result.body, {
    status: result.status,
    headers: { "content-type": contentType },
  });
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new DOMException("The operation was aborted.", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function describeTransportError(error: unknown, timeoutLabel: string): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message.trim() : "";
  if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    message === "测试超时" ||
    /超时/.test(message)
  ) {
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
