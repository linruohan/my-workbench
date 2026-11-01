import { describe, expect, it } from "vitest";
import {
  APP_DATA_DIR_NAME,
  DEFAULT_DATA_DIR_DISPLAY,
  isTauriRuntime,
} from "./paths";

describe("paths", () => {
  it("documents the Windows AppData default folder", () => {
    expect(APP_DATA_DIR_NAME).toBe("my-workbench");
    expect(DEFAULT_DATA_DIR_DISPLAY).toBe(
      "C:\\Users\\Administrator\\AppData\\Roaming\\my-workbench",
    );
    expect(isTauriRuntime()).toBe(false);
  });
});
