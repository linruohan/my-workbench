import { describe, expect, it } from "vitest";
import {
  decodeTaskRepeat,
  encodeTaskRepeat,
  makePresetSchedule,
} from "../src/index.js";

describe("task-repeat", () => {
  it("round-trips a timed schedule through repeat_cfg_id text", () => {
    const schedule = makePresetSchedule("daily", "09:30");
    const encoded = encodeTaskRepeat(schedule);
    expect(decodeTaskRepeat(encoded)).toEqual(schedule);
    expect(decodeTaskRepeat(null)).toBeNull();
    expect(decodeTaskRepeat("not-json")).toBeNull();
  });
});
