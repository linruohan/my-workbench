import { isTauriRuntime } from "../lib/paths";

export type WebSessionBounds = {
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** When set, the in-page fullscreen button follows this flag. */
  fullscreen?: boolean;
};

/** Desktop builds draw the page in its own webview so site cookies can stick. */
export function webSessionEmbedded(): boolean {
  return isTauriRuntime();
}

async function invoke(command: string, args?: Record<string, unknown>): Promise<void> {
  const { invoke: call } = await import("@tauri-apps/api/core");
  await call(command, args);
}

/** Opens the page and returns the URL that should be stored. A spent launch token is removed. */
export async function webSessionShow(bounds: WebSessionBounds): Promise<string> {
  if (!isTauriRuntime()) return bounds.url;
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call<string>("web_session_show", {
    ...bounds,
    fullscreen: bounds.fullscreen ?? false,
  });
}

export async function webSessionReload(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("web_session_reload");
}

export async function webSessionHide(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("web_session_hide");
}

export async function webSessionClose(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("web_session_close");
}
