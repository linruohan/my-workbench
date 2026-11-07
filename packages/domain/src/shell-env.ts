/**
 * Allowlist + managed WB_* overlay for agent-spawned shell / PTY environments.
 * Keep in sync with `apps/desktop/src-tauri/src/shell_env.rs`.
 *
 * Security boundary is the allowlist (not a denylist of secret-shaped names).
 * Unknown host vars — including API keys — never reach model-run commands.
 * Managed `WB_*` facts are rebuilt per call (DSH shell-env inspired).
 */

const SHELL_ENV_ALLOWLIST = [
  // Path / locale / identity
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "USER",
  "USERNAME",
  "LOGNAME",
  "SHELL",
  "COMSPEC",
  // Windows system
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "OS",
  // Temp / locale / terminal
  "TMP",
  "TEMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  "TERM",
  "COLORTERM",
  // Display (optional GUI CLIs on Unix)
  "DISPLAY",
  "WAYLAND_DISPLAY",
] as const;

const ALLOW_SET = new Set(SHELL_ENV_ALLOWLIST.map((key) => key.toUpperCase()));

/** Marker injected into every scrubbed agent shell environment. */
export const WB_AGENT_SHELL_ENV = "WB_AGENT_SHELL";
/** Workbench app data / home directory (absolute). */
export const WB_HOME_ENV = "WB_HOME";
/** Owning agent session id when the call has one. */
export const WB_SESSION_ID_ENV = "WB_SESSION_ID";
/** Bound workspace root for this call. */
export const WB_WORKSPACE_ROOT_ENV = "WB_WORKSPACE_ROOT";
/** Resolved launch cwd for this call. */
export const WB_CWD_ENV = "WB_CWD";

const MANAGED_KEYS = [
  WB_AGENT_SHELL_ENV,
  WB_HOME_ENV,
  WB_SESSION_ID_ENV,
  WB_WORKSPACE_ROOT_ENV,
  WB_CWD_ENV,
] as const;

export function isShellEnvAllowed(key: string): boolean {
  const normalized = key.trim().toUpperCase();
  if (!normalized) return false;
  if (normalized.startsWith("WB_")) return false;
  return ALLOW_SET.has(normalized);
}

export function isManagedShellEnvKey(key: string): boolean {
  const normalized = key.trim().toUpperCase();
  return (MANAGED_KEYS as readonly string[]).includes(normalized);
}

/**
 * Trusted per-call WB_* snapshot (DSH `DSH_*` analogue).
 * Empty / whitespace values are omitted except the always-on shell marker.
 */
export function collectManagedShellEnv(input?: {
  home?: string | null;
  sessionId?: string | null;
  workspaceRoot?: string | null;
  cwd?: string | null;
}): Record<string, string> {
  const out: Record<string, string> = {
    [WB_AGENT_SHELL_ENV]: "1",
  };
  const home = input?.home?.trim();
  if (home) out[WB_HOME_ENV] = home;
  const sessionId = input?.sessionId?.trim();
  if (sessionId) out[WB_SESSION_ID_ENV] = sessionId;
  const workspaceRoot = input?.workspaceRoot?.trim();
  if (workspaceRoot) out[WB_WORKSPACE_ROOT_ENV] = workspaceRoot;
  const cwd = input?.cwd?.trim();
  if (cwd) out[WB_CWD_ENV] = cwd;
  return out;
}

/** Build a fresh env from an input map; drops everything not on the allowlist. */
export function scrubShellEnv(
  input: Record<string, string>,
  managed?: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isShellEnvAllowed(key)) continue;
    // Preserve the first-seen preferred casing for each logical key.
    const existing = Object.keys(out).find((k) => k.toUpperCase() === key.toUpperCase());
    if (existing) continue;
    out[key] = value;
  }
  const overlay = managed ?? collectManagedShellEnv();
  for (const [key, value] of Object.entries(overlay)) {
    if (!key.startsWith("WB_")) continue;
    out[key] = value;
  }
  if (!out[WB_AGENT_SHELL_ENV]) out[WB_AGENT_SHELL_ENV] = "1";
  return out;
}

export function shellEnvAllowlist(): readonly string[] {
  return SHELL_ENV_ALLOWLIST;
}

export function managedShellEnvKeys(): readonly string[] {
  return MANAGED_KEYS;
}
