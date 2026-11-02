import { writeClipboard } from "./clipboard";

/** Copy the fenced block under a `.md-code__copy` click. Returns whether it handled the event. */
export function copyCodeBlock(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const button = target.closest(".md-code__copy");
  if (!(button instanceof HTMLButtonElement)) return false;
  const source = button.closest(".md-code")?.getAttribute("data-code");
  if (source == null) return false;
  const previous = button.textContent;
  void writeClipboard(source).then((ok) => {
    button.textContent = ok ? "已复制" : "复制失败";
    window.setTimeout(() => {
      if (button.isConnected) button.textContent = previous || "复制";
    }, 1200);
  });
  return true;
}
