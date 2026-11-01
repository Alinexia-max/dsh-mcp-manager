import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DiscoveredServer, DiscoveredTransport, SourceId } from "./client-types.js";
import { messageOf } from "./store.js";

/**
 * 只读来源发现层。
 *
 * 聚合各家 MCP 客户端自己的配置文件（CodeBuddy / Claude Desktop / Cursor / VS Code），
 * 形态基本都是顶层 `mcpServers`（VS Code 用 `servers`）。本模块**只读不写**：
 * - 回传前端的条目一律掩码 `env` / `headers` 的值；
 * - 导入时由服务端重新读一次原文取真实值，密钥不经过前端。
 */

export type ReadonlySourceId = Exclude<SourceId, "dsh">;

/** 服务端内部使用的原始条目（未掩码），只在导入路径上出现。 */
export interface RawServer {
  name: string;
  transport: DiscoveredTransport;
  /** 配置文件里原始的 `type`，用于解释「为什么不可导入」。 */
  rawType?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** 含 `${VAR}` 的字段名，导入后需要手动替换成真实值。 */
  placeholders: string[];
}

export interface RawSource {
  id: ReadonlySourceId;
  configPath: string;
  servers: Record<string, RawServer>;
  /** 配置文件是否存在；不存在的来源不渲染空分组。 */
  existing: boolean;
  error?: string;
}

/** 一个只读来源：算好的路径 + 顶层容器键（按顺序取第一个命中的）。 */
export interface SourceDefinition {
  id: ReadonlySourceId;
  path: string;
  containerKeys: string[];
}

const SECRET_MASK = "***";
const PLACEHOLDER = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;

function envPath(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Windows 用 %APPDATA%，macOS 用 Application Support，其余按 XDG 约定。 */
function configHome(): string {
  if (process.platform === "win32") return envPath("APPDATA") ?? join(homedir(), "AppData", "Roaming");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  return join(homedir(), ".config");
}

export function codebuddyMcpPath(): string {
  // 环境变量用于测试与非常规安装位置；正常部署走 ~/.codebuddy/mcp.json。
  return envPath("DSMM_CODEBUDDY_MCP") ?? join(homedir(), ".codebuddy", "mcp.json");
}

/** 每次调用都重新算路径，测试改环境变量后立即生效。 */
export function sourceDefinitions(): SourceDefinition[] {
  return [
    { id: "codebuddy", path: codebuddyMcpPath(), containerKeys: ["mcpServers"] },
    {
      id: "claude",
      path: envPath("DSMM_CLAUDE_MCP") ?? join(configHome(), "Claude", "claude_desktop_config.json"),
      containerKeys: ["mcpServers"],
    },
    {
      id: "cursor",
      path: envPath("DSMM_CURSOR_MCP") ?? join(homedir(), ".cursor", "mcp.json"),
      containerKeys: ["mcpServers"],
    },
    {
      id: "vscode",
      path: envPath("DSMM_VSCODE_MCP") ?? join(configHome(), "Code", "User", "mcp.json"),
      containerKeys: ["servers", "mcpServers"],
    },
  ];
}

function plainStrings(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "string") return undefined;
    out[key] = item;
  }
  return out;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** 把一条配置归一化；无法识别的形态返回 undefined（跳过而不是整份报错）。 */
function normalize(name: string, value: unknown): RawServer | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;

  const declared = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : undefined;
  const command = text(raw.command);
  const url = text(raw.url);

  let transport: DiscoveredTransport;
  if (command !== undefined) {
    // CodeBuddy 的 stdio 条目通常不写 type，靠 command 判定。
    transport = "stdio";
  } else if (url !== undefined) {
    transport = declared === "sse" ? "unsupported" : "streamable-http";
  } else {
    return undefined;
  }

  const env = plainStrings(raw.env);
  const headers = plainStrings(raw.headers);
  const args = stringList(raw.args);
  const cwd = text(raw.cwd);
  const placeholders: string[] = [];
  const scan = (field: string, candidate: string | undefined) => {
    if (candidate !== undefined && PLACEHOLDER.test(candidate)) placeholders.push(field);
  };

  scan("command", command);
  scan("url", url);
  scan("cwd", cwd);
  if (args !== undefined) {
    args.forEach((argument, index) => scan(`args[${index}]`, argument));
  }
  for (const [key, item] of Object.entries(env ?? {})) scan(`env.${key}`, item);
  for (const [key, item] of Object.entries(headers ?? {})) scan(`headers.${key}`, item);

  return {
    name,
    transport,
    ...(declared === undefined ? {} : { rawType: declared }),
    ...(command === undefined ? {} : { command }),
    ...(args === undefined ? {} : { args }),
    ...(env === undefined ? {} : { env }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(url === undefined ? {} : { url }),
    ...(headers === undefined ? {} : { headers }),
    placeholders,
  };
}

function mask(pairs?: Record<string, string>): Record<string, string> | undefined {
  if (pairs === undefined) return undefined;
  return Object.fromEntries(Object.keys(pairs).map((key) => [key, SECRET_MASK]));
}

/** 转成可回传前端的形态：密钥只留键名，值统一 `***`。 */
export function toDiscovered(server: RawServer): DiscoveredServer {
  return {
    name: server.name,
    transport: server.transport,
    ...(server.rawType === undefined ? {} : { rawType: server.rawType }),
    ...(server.command === undefined ? {} : { command: server.command }),
    ...(server.args === undefined ? {} : { args: server.args }),
    ...(mask(server.env) === undefined ? {} : { env: mask(server.env) }),
    ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
    ...(server.url === undefined ? {} : { url: server.url }),
    ...(mask(server.headers) === undefined ? {} : { headers: mask(server.headers) }),
    importable: server.transport !== "unsupported",
    placeholders: server.placeholders,
  };
}

/** 从顶层对象里按容器键取条目；键不存在视为「这份配置没有服务器」。 */
function extractServers(parsed: unknown, containerKeys: string[]): { servers: Record<string, RawServer>; error?: string } {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { servers: {}, error: "顶层必须是对象" };
  }
  const root = parsed as Record<string, unknown>;
  for (const key of containerKeys) {
    const container = root[key];
    if (container === undefined) continue;
    if (container === null || typeof container !== "object" || Array.isArray(container)) {
      return { servers: {}, error: `${key} 必须是对象` };
    }
    const servers: Record<string, RawServer> = {};
    for (const [name, value] of Object.entries(container as Record<string, unknown>)) {
      const normalized = normalize(name, value);
      if (normalized !== undefined) servers[name] = normalized;
    }
    return { servers };
  }
  return { servers: {} };
}

/**
 * 读取一个来源的配置。
 *
 * 文件不存在视为「没有服务器」（`existing: false`，面板不渲染该分组）；文件损坏只记
 * `error`，不抛错——面板要能带着错误继续展示其它来源，而不是整块挂掉。
 */
export async function readSource(definition: SourceDefinition): Promise<RawSource> {
  const file = definition.path;
  const empty: RawSource = { id: definition.id, configPath: file, servers: {}, existing: false };
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") return empty;
    return { ...empty, existing: true, error: `无法读取 ${file}：${messageOf(caught)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...empty, existing: true, error: `${file} 不是合法 JSON` };
  }
  const extracted = extractServers(parsed, definition.containerKeys);
  if (extracted.error !== undefined) {
    return { ...empty, existing: true, error: `${file} 的 ${extracted.error}` };
  }
  return { id: definition.id, configPath: file, servers: extracted.servers, existing: true };
}

/** 一次读完所有来源；单份损坏不影响其它来源。 */
export async function readAllSources(): Promise<RawSource[]> {
  return Promise.all(sourceDefinitions().map((definition) => readSource(definition)));
}

/** 兼容旧调用方：只读 CodeBuddy 一份。 */
export async function readCodeBuddySource(file: string = codebuddyMcpPath()): Promise<RawSource> {
  return readSource({ id: "codebuddy", path: file, containerKeys: ["mcpServers"] });
}

/**
 * 解析用户粘贴的配置片段。
 *
 * 与读盘路径共用同一套归一化逻辑，所以 `mcpServers` / `servers` 两种形态都能吃下。
 * 返回 `error` 而不是抛错，路由层据此给出 400 文案。
 */
export function parseMcpConfig(text: string): { servers: Record<string, RawServer>; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (caught) {
    return { servers: {}, error: `不是合法 JSON：${messageOf(caught)}` };
  }
  return extractServers(parsed, ["mcpServers", "servers"]);
}
