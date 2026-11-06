import { describe, expect, it } from "vitest";
import {
  AGENT_LOG_VIRTUAL_MIN,
  agentLogVisibleRange,
  buildHeightMetrics,
  estimateAgentTurnHeight,
} from "./agent-log-virtual";

describe("agent log virtual", () => {
  it("builds offsets from estimated heights", () => {
    const metrics = buildHeightMetrics([10, 20, 30], 0);
    expect(metrics.offsets).toEqual([0, 10, 30]);
    expect(metrics.total).toBe(60);
    const withGap = buildHeightMetrics([10, 20], 4);
    expect(withGap.offsets).toEqual([0, 14]);
    expect(withGap.total).toBe(34);
  });

  it("estimates taller agent turns when there is prose", () => {
    expect(estimateAgentTurnHeight("marker", 1)).toBeLessThan(
      estimateAgentTurnHeight("user", 3),
    );
    expect(estimateAgentTurnHeight("agent", 0, 2, 0)).toBeLessThan(
      estimateAgentTurnHeight("agent", 0, 2, 20),
    );
  });

  it("windows a long transcript", () => {
    const heights = Array.from({ length: AGENT_LOG_VIRTUAL_MIN + 10 }, () => 80);
    const metrics = buildHeightMetrics(heights);
    const range = agentLogVisibleRange(metrics, 800, 240, 2);
    expect(range.start).toBeGreaterThan(0);
    expect(range.end).toBeLessThan(heights.length);
    expect(range.end).toBeGreaterThan(range.start);
  });
});
