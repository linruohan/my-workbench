import { describe, expect, it } from "vitest";
import { APP_DATA_DIR_NAME, DEFAULT_DATA_DIR_DISPLAY, isTauriRuntime } from "./paths";

describe("paths", () => {
  it("documents the Windows AppData default folder", () => {
    expect(APP_DATA_DIR_NAME).toBe("my-workbench");
    // 通用形式：不硬编码本机用户名，打包到其他机器上也能展示合理路径
    expect(DEFAULT_DATA_DIR_DISPLAY).toBe("%APPDATA%\\my-workbench");
    expect(isTauriRuntime()).toBe(false);
  });
});
