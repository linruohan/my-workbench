import { errorMessage } from "./errors";
import { isTauriRuntime } from "./paths";

const ALLOWED = /^(https?:|mailto:)/i;

/** Open a URL in the system browser / default handler. */
export async function openExternalUrl(url: string): Promise<void> {
  const href = url.trim();
  if (!ALLOWED.test(href)) {
    throw new Error("只能打开 http(s) 或 mailto 链接");
  }
  if (!isTauriRuntime()) {
    window.open(href, "_blank", "noopener,noreferrer");
    return;
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_external", { url: href });
  } catch (err) {
    throw new Error(errorMessage(err, "无法打开链接"));
  }
}

/** Resolve an external http(s)/mailto link under a click target (skips TOC anchors). */
export function externalHrefFromEvent(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const link = target.closest("a[href]");
  if (!(link instanceof HTMLAnchorElement)) return null;
  if (link.closest(".md-toc")) return null;
  const href = (link.getAttribute("href") ?? "").trim();
  if (!href || href.startsWith("#")) return null;
  if (!ALLOWED.test(href)) return null;
  return href;
}
