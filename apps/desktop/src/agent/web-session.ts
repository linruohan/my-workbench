import { isTauriRuntime } from "../lib/paths";

export type WebSessionBounds = {
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Desktop builds draw the page in its own webview so site cookies can stick. */
export function webSessionEmbedded(): boolean {
  return isTauriRuntime();
}

async function invoke(command: string, args?: Record<string, unknown>): Promise<void> {
  const { invoke: call } = await import("@tauri-apps/api/core");
  await call(command, args);
}

export async function webSessionShow(bounds: WebSessionBounds): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("web_session_show", { ...bounds });
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
