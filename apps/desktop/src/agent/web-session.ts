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

/**
 * The embedded page is a native window above the shell. While a hold is
 * active, show() must not put that window back over a modal.
 */
let holds = 0;
let epoch = 0;
const resumeListeners = new Set<() => void>();

export function webSessionHeld(): boolean {
  return holds > 0;
}

export function onWebSessionResume(listener: () => void): () => void {
  resumeListeners.add(listener);
  return () => {
    resumeListeners.delete(listener);
  };
}

function notifyResume(): void {
  if (holds > 0) return;
  for (const listener of [...resumeListeners]) listener();
}

/** Hide the embedded page until the returned function runs. Nested holds stay hidden. */
export async function holdWebSession(): Promise<() => void> {
  holds += 1;
  epoch += 1;
  if (holds === 1) await webSessionHide().catch(() => undefined);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds = Math.max(0, holds - 1);
    if (holds === 0) notifyResume();
  };
}

/**
 * Hide the native page before a modal. Outside the desktop app this is a no-op
 * so browser dialogs still open in the same turn.
 */
export function coverEmbeddedWebSession(): Promise<() => void> {
  if (!webSessionEmbedded()) return Promise.resolve(() => {});
  return holdWebSession();
}

async function invoke(command: string, args?: Record<string, unknown>): Promise<void> {
  const { invoke: call } = await import("@tauri-apps/api/core");
  await call(command, args);
}

/** Opens the page and returns the URL that should be stored. A spent launch token is removed. */
export async function webSessionShow(bounds: WebSessionBounds): Promise<string> {
  if (!isTauriRuntime()) return bounds.url;
  const seen = epoch;
  const { invoke: call } = await import("@tauri-apps/api/core");
  const opened = await call<string>("web_session_show", {
    ...bounds,
    fullscreen: bounds.fullscreen ?? false,
  });
  if (seen !== epoch || holds > 0) {
    await webSessionHide().catch(() => undefined);
    if (holds === 0) notifyResume();
  }
  return opened;
}

export async function webSessionReload(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("web_session_reload");
}

/** Push the Settings → 外观 webpage default font into the embedded session. */
export async function webSessionSetDefaultFont(font: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("web_session_set_default_font", { font });
}

export async function webSessionHide(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("web_session_hide");
}

export async function webSessionClose(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("web_session_close");
}
