/**
 * MCP server registration. This records how a server would be reached.
 * The host does not spawn the process from chat.
 */

export type McpServer = {
  id: string;
  name: string;
  command: string;
  args: string[];
  url: string;
  enabled: boolean;
  source: string;
};

export function addMcpServer(
  list: readonly McpServer[],
  input: { name: string; command?: string; args?: string[]; url?: string },
): { servers: McpServer[]; added: McpServer | null; reason?: string } {
  const name = input.name.trim();
  const command = (input.command ?? "").trim();
  const url = (input.url ?? "").trim();
  if (!name) return { servers: [...list], added: null, reason: "请填写服务器名称" };
  if (!command && !url) {
    return { servers: [...list], added: null, reason: "请填写命令或 URL" };
  }
  if (list.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
    return { servers: [...list], added: null, reason: "已经有同名服务器" };
  }
  const added: McpServer = {
    id: `mcp:user:${name.toLowerCase()}`,
    name,
    command,
    args: (input.args ?? []).map((item) => item.trim()).filter(Boolean),
    url,
    enabled: true,
    source: "user",
  };
  return { servers: [...list, added], added };
}

export function removeMcpServer(list: readonly McpServer[], id: string): McpServer[] {
  return list.filter((item) => item.id !== id);
}

export function setMcpServerEnabled(
  list: readonly McpServer[],
  id: string,
  enabled: boolean,
): McpServer[] {
  return list.map((item) => (item.id === id ? { ...item, enabled } : item));
}

export function parseMcpDocument(raw: string, source: string): McpServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const record = parsed as Record<string, unknown>;
  const servers = record.mcpServers ?? record;
  return parseMcpMap(servers, source);
}

export function parseMcpMap(value: unknown, source: string): McpServer[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const out: McpServer[] = [];
  for (const [name, spec] of Object.entries(value as Record<string, unknown>)) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) continue;
    const row = spec as Record<string, unknown>;
    const command = typeof row.command === "string" ? row.command.trim() : "";
    const url = typeof row.url === "string" ? row.url.trim() : "";
    if (!command && !url) continue;
    const args = Array.isArray(row.args)
      ? row.args.filter((item): item is string => typeof item === "string")
      : [];
    out.push({
      id: `mcp:${source}:${name.toLowerCase()}`,
      name,
      command,
      args,
      url,
      enabled: row.enabled !== false,
      source,
    });
  }
  return out;
}

export function mcpEndpointLabel(server: McpServer): string {
  if (server.url) return server.url;
  return [server.command, ...server.args].filter(Boolean).join(" ");
}

export function formatMcpForPrompt(list: readonly McpServer[]): string {
  const enabled = list.filter((item) => item.enabled);
  if (enabled.length === 0) return "";
  const lines = enabled.map(
    (item) => `- ${item.name}：${mcpEndpointLabel(item)}（已登记，尚未连接）`,
  );
  return [
    "已登记的 MCP 服务器。宿主这一版不会代为启动外部进程，不要声称已经调用成功。",
    ...lines,
  ].join("\n");
}
