import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DiscoveredServer, DiscoveredTransport, SourceId } from "./client-types.js";
import { messageOf } from "./store.js";

/**
 * 只读来源发现层。
 *
 * 第一版只接 CodeBuddy：用户级 MCP 配置在 `~/.codebuddy/mcp.json`，形态与
 * Claude Code 一致（顶层 `mcpServers` 对象）。本模块**只读不写**：
 * - 回传前端的条目一律掩码 `env` / `headers` 的值；
 * - 导入时由服务端重新读一次原文取真实值，密钥不经过前端。
 */

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
  id: SourceId;
  configPath: string;
  servers: Record<string, RawServer>;
  error?: string;
}

const SECRET_MASK = "***";
const PLACEHOLDER = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;

export function codebuddyMcpPath(): string {
  // 环境变量用于测试与非常规安装位置；正常部署走 ~/.codebuddy/mcp.json。
  const override = process.env.DSMM_CODEBUDDY_MCP;
  if (typeof override === "string" && override.trim() !== "") return override;
  return join(homedir(), ".codebuddy", "mcp.json");
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

/**
 * 读取 CodeBuddy 的用户级 MCP 配置。
 *
 * 文件不存在视为「没有服务器」；文件损坏只记 `error`，不抛错——面板要能带着
 * 错误继续展示其它来源，而不是整块挂掉。
 */
export async function readCodeBuddySource(file: string = codebuddyMcpPath()): Promise<RawSource> {
  const empty: RawSource = { id: "codebuddy", configPath: file, servers: {} };
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") return empty;
    return { ...empty, error: `无法读取 ${file}：${messageOf(caught)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...empty, error: `${file} 不是合法 JSON` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...empty, error: `${file} 顶层必须是对象` };
  }

  const container = (parsed as Record<string, unknown>).mcpServers;
  if (container === undefined) return empty;
  if (container === null || typeof container !== "object" || Array.isArray(container)) {
    return { ...empty, error: `${file} 的 mcpServers 必须是对象` };
  }

  const servers: Record<string, RawServer> = {};
  for (const [name, value] of Object.entries(container as Record<string, unknown>)) {
    const normalized = normalize(name, value);
    if (normalized !== undefined) servers[name] = normalized;
  }
  return { id: "codebuddy", configPath: file, servers };
}
