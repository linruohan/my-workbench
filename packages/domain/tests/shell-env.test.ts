import { describe, expect, it } from "vitest";
import {
  collectManagedShellEnv,
  isManagedShellEnvKey,
  isShellEnvAllowed,
  scrubShellEnv,
  WB_AGENT_SHELL_ENV,
  WB_CWD_ENV,
  WB_HOME_ENV,
  WB_SESSION_ID_ENV,
  WB_WORKSPACE_ROOT_ENV,
} from "../src/shell-env";

describe("shell env scrub", () => {
  it("keeps allowlisted keys and drops secrets", () => {
    const scrubbed = scrubShellEnv({
      PATH: "/usr/bin",
      HOME: "/home/me",
      OPENAI_API_KEY: "sk-secret",
      GITHUB_TOKEN: "ghp_x",
      AWS_SECRET_ACCESS_KEY: "aws",
      NODE_OPTIONS: "--require ./inject.js",
      EDITOR: "vim",
      WB_HOME: "should-not-inherit",
    });
    expect(scrubbed.PATH).toBe("/usr/bin");
    expect(scrubbed.HOME).toBe("/home/me");
    expect(scrubbed[WB_AGENT_SHELL_ENV]).toBe("1");
    expect(scrubbed.OPENAI_API_KEY).toBeUndefined();
    expect(scrubbed.GITHUB_TOKEN).toBeUndefined();
    expect(scrubbed.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(scrubbed.NODE_OPTIONS).toBeUndefined();
    expect(scrubbed.EDITOR).toBeUndefined();
    expect(scrubbed[WB_HOME_ENV]).toBeUndefined();
  });

  it("matches allowlist case-insensitively and rejects ambient WB_*", () => {
    expect(isShellEnvAllowed("Path")).toBe(true);
    expect(isShellEnvAllowed("systemroot")).toBe(true);
    expect(isShellEnvAllowed("openai_api_key")).toBe(false);
    expect(isShellEnvAllowed("WB_HOME")).toBe(false);
    expect(isManagedShellEnvKey(WB_SESSION_ID_ENV)).toBe(true);
  });

  it("dedupes case variants and always sets the marker", () => {
    const scrubbed = scrubShellEnv({
      Path: "C:\\Windows\\System32",
      PATH: "/should-not-win",
    });
    expect(scrubbed.Path).toBe("C:\\Windows\\System32");
    expect(scrubbed.PATH).toBeUndefined();
    expect(scrubbed[WB_AGENT_SHELL_ENV]).toBe("1");
  });

  it("merges managed WB_* overlay per call", () => {
    const managed = collectManagedShellEnv({
      home: "C:/Users/me/AppData/Roaming/my-workbench",
      sessionId: "thr_9",
      workspaceRoot: "D:/ws",
      cwd: "D:/ws/src",
    });
    expect(managed).toEqual({
      [WB_AGENT_SHELL_ENV]: "1",
      [WB_HOME_ENV]: "C:/Users/me/AppData/Roaming/my-workbench",
      [WB_SESSION_ID_ENV]: "thr_9",
      [WB_WORKSPACE_ROOT_ENV]: "D:/ws",
      [WB_CWD_ENV]: "D:/ws/src",
    });
    const scrubbed = scrubShellEnv({ PATH: "/bin" }, managed);
    expect(scrubbed[WB_SESSION_ID_ENV]).toBe("thr_9");
    expect(scrubbed[WB_WORKSPACE_ROOT_ENV]).toBe("D:/ws");
    expect(scrubbed[WB_CWD_ENV]).toBe("D:/ws/src");
    expect(scrubbed[WB_HOME_ENV]).toContain("my-workbench");
  });
});
