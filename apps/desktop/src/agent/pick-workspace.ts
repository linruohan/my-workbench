import { isTauriRuntime } from "../lib/paths";
import { pickDirectory } from "../notes/kb-api";

type AskPath = (opts: {
  title: string;
  label: string;
  initialValue?: string;
}) => Promise<string | null>;

/** Open the OS folder picker (or an in-app path prompt in the browser). */
export async function pickAgentWorkspaceFolder(
  askPath?: AskPath,
): Promise<string | null> {
  if (isTauriRuntime()) {
    return pickDirectory("选择工作区目录");
  }
  if (!askPath) return null;
  const typed = await askPath({
    title: "选择工作区",
    label: "工作区目录的完整路径",
  });
  const path = typed?.trim() ?? "";
  return path || null;
}
