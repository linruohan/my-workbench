import { visibleRange, type RowMetrics } from "../notes/md-live-virtual";

/** Start windowing once the transcript is long enough to hurt. */
export const AGENT_LOG_VIRTUAL_MIN = 28;
export const AGENT_LOG_OVERSCAN = 6;
/** Matches .agent__log-body gap (var(--wb-space-4)). */
export const AGENT_LOG_GAP_PX = 16;

export type AgentLogTurnKind = "user" | "agent" | "marker";

export function buildHeightMetrics(
  heights: readonly number[],
  gapPx = AGENT_LOG_GAP_PX,
): RowMetrics {
  const list = heights.map((height) => Math.max(0, height));
  const offsets = new Array<number>(list.length);
  let y = 0;
  for (let i = 0; i < list.length; i += 1) {
    offsets[i] = y;
    y += list[i] ?? 0;
    if (i < list.length - 1) y += Math.max(0, gapPx);
  }
  return { heights: list, offsets, total: y };
}

/** Rough turn height so the scroll thumb stays usable before measure. */
export function estimateAgentTurnHeight(
  kind: AgentLogTurnKind,
  textLines: number,
  toolCount = 0,
  proseLines = 0,
): number {
  if (kind === "marker") return 28;
  if (kind === "user") {
    const lines = Math.max(1, textLines);
    return 40 + lines * 22 + 28;
  }
  const tools = Math.max(0, toolCount) * 36;
  const prose = Math.min(480, Math.max(0, proseLines) * 22 + (proseLines > 0 ? 20 : 0));
  return Math.max(64, 36 + tools + prose);
}

export function agentLogVisibleRange(
  metrics: RowMetrics,
  scrollTop: number,
  viewportHeight: number,
  overscan = AGENT_LOG_OVERSCAN,
): { start: number; end: number } {
  return visibleRange(metrics, scrollTop, viewportHeight, overscan);
}
