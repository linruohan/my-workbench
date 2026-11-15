/**
 * 笔记挂起写入的 flush 注册表：KnowledgeView 的自动保存是 800ms 防抖 +
 * 异步写盘，关窗走 Tauri CloseRequested 时 beforeunload 已不可靠，
 * 这里让退出流程能在关窗前把挂起的笔记内容写完。
 */

type NoteFlusher = () => Promise<void> | void;

let flusher: NoteFlusher | null = null;

export function registerNoteFlusher(fn: NoteFlusher | null): void {
  flusher = fn;
}

/** 写完所有挂起的笔记保存；无注册方（非知识库视图）时立即返回。 */
export async function flushNoteSaves(): Promise<void> {
  const fn = flusher;
  if (!fn) return;
  await fn();
}
