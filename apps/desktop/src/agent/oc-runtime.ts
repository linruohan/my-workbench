import { readOcRunOutput } from "@wb/domain";
import { isTauriRuntime } from "../lib/paths";

/** Run one prompt through the local OpenCode CLI and its default free models. */
export async function completeViaOpenCode(
  modelId: string,
  prompt: string,
): Promise<string> {
  if (!isTauriRuntime()) throw new Error("需要在桌面应用里调用 OpenCode");
  const { invoke } = await import("@tauri-apps/api/core");
  let stdout: string;
  try {
    stdout = await invoke<string>("oc_complete", { modelId, prompt });
  } catch (error) {
    const message =
      typeof error === "string"
        ? error.trim()
        : error instanceof Error
          ? error.message.trim()
          : "";
    throw new Error(message || "OpenCode 调用失败");
  }
  const parsed = readOcRunOutput(stdout);
  if (parsed.ok === false) throw new Error(parsed.message);
  return parsed.text;
}
