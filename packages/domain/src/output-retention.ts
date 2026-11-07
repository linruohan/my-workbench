/**
 * Head/tail preview + recovery notice for oversized tool outputs (DSH spill/retention-inspired).
 */

export type RetentionKind = "head" | "tail" | "headTail";

export type RetentionPreview = {
  text: string;
  omittedBytes: number;
  keptBytes: number;
  totalBytes: number;
};

export type RetentionNotice = {
  preview: string;
  notice: string;
  omittedBytes: number;
  totalBytes: number;
};

/** Default inline budget for shell-like streams (bytes of UTF-16 code units ≈ JS string length). */
export const DEFAULT_INLINE_HEAD_BYTES = 24 * 1024;
export const DEFAULT_INLINE_TAIL_BYTES = 16 * 1024;

export function retainText(
  content: string,
  options?: {
    kind?: RetentionKind;
    headBytes?: number;
    tailBytes?: number;
  },
): RetentionPreview {
  const kind = options?.kind ?? "headTail";
  const headBytes = Math.max(0, options?.headBytes ?? DEFAULT_INLINE_HEAD_BYTES);
  const tailBytes = Math.max(0, options?.tailBytes ?? DEFAULT_INLINE_TAIL_BYTES);
  const totalBytes = content.length;
  if (kind === "head") {
    if (totalBytes <= headBytes) {
      return { text: content, omittedBytes: 0, keptBytes: totalBytes, totalBytes };
    }
    return {
      text: content.slice(0, headBytes),
      omittedBytes: totalBytes - headBytes,
      keptBytes: headBytes,
      totalBytes,
    };
  }
  if (kind === "tail") {
    if (totalBytes <= tailBytes) {
      return { text: content, omittedBytes: 0, keptBytes: totalBytes, totalBytes };
    }
    return {
      text: content.slice(totalBytes - tailBytes),
      omittedBytes: totalBytes - tailBytes,
      keptBytes: tailBytes,
      totalBytes,
    };
  }
  const budget = headBytes + tailBytes;
  if (totalBytes <= budget) {
    return { text: content, omittedBytes: 0, keptBytes: totalBytes, totalBytes };
  }
  const head = content.slice(0, headBytes);
  const tail = content.slice(totalBytes - tailBytes);
  return {
    text: `${head}\n…\n${tail}`,
    omittedBytes: totalBytes - budget,
    keptBytes: budget,
    totalBytes,
  };
}

/** One vision attachment omitted from the current model request. */
export type ImageOffloadItem = {
  id: string;
  path: string;
  name?: string;
  reason: "count" | "bytes";
};

/**
 * Model-facing notice when older pending images exceed the per-turn vision budget
 * (light DSH image-offload / spill-policy style; paths stay recoverable via read_image).
 */
export function formatImageOffloadNotice(offloaded: readonly ImageOffloadItem[]): string {
  if (!offloaded.length) return "";
  const lines = offloaded.map((item) => {
    const label = item.path.trim() || item.name?.trim() || item.id;
    const why = item.reason === "count" ? "超过单轮张数上限" : "超过单轮体积上限";
    return `- ${label}（${why}；可用 read_image 再读）`;
  });
  return [
    "<image_offload>",
    `本轮 vision 未附带 ${offloaded.length} 张较早图片（仍保存在会话附件库）：`,
    ...lines,
    "</image_offload>",
  ].join("\n");
}

/** Build model-facing preview + footer that points at a recoverable spill path. */
export function formatRetentionNotice(input: {
  content: string;
  spillPath?: string | null;
  spillBytes?: number | null;
  toolHint?: string;
  kind?: RetentionKind;
  headBytes?: number;
  tailBytes?: number;
}): RetentionNotice {
  const preview = retainText(input.content, {
    kind: input.kind,
    headBytes: input.headBytes,
    tailBytes: input.tailBytes,
  });
  if (preview.omittedBytes <= 0 && !input.spillPath) {
    return {
      preview: preview.text,
      notice: "",
      omittedBytes: 0,
      totalBytes: preview.totalBytes,
    };
  }
  const path = input.spillPath?.trim() || "";
  const spillBytes = input.spillBytes ?? preview.totalBytes;
  const hint =
    input.toolHint?.trim() ||
    (path
      ? `用 read 打开 ${path}（可加 offset/limit），或用 grep 搜索该文件。`
      : "完整输出未保留；请缩小命令输出或改用写入文件的方式。");
  const omitted = path
    ? `已省略约 ${preview.omittedBytes || Math.max(0, spillBytes - preview.keptBytes)} 字符；全文约 ${spillBytes} 字符，已写入 ${path}。`
    : `已省略约 ${preview.omittedBytes} 字符（原文约 ${preview.totalBytes} 字符）。`;
  const notice = `${omitted} ${hint}`.trim();
  return {
    preview: preview.text,
    notice,
    omittedBytes: preview.omittedBytes,
    totalBytes: preview.totalBytes,
  };
}
