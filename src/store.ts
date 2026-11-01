import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * 配置存储：`$DSH_HOME/mcp-manager/servers.json`。
 *
 * 为什么不写 profile 的 cordis.patch.yml：那里是 Loader 的组合层，写入需要与
 * config-editor / plugin-manager 的文件锁和盘面状态协调；插件自己的条目由一个
 * 私有文件表达，既够用又不越权。
 */

export type Transport = "stdio" | "streamable-http";

/** 上游 `dsh-mcp-client` 的重连策略；未设置的字段由上游用自己的默认值（500ms→30s，10 次）。 */
export interface ReconnectPolicy {
  enabled?: boolean;
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
}

/** 回传给前端的密钥占位符；写回时该值表示“沿用旧值”。 */
export const SECRET_MASK = "***";
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const MIN_TOOL_CALL_TIMEOUT_MS = 1_000;
const MAX_TOOL_CALL_TIMEOUT_MS = 600_000;
const MIN_RECONNECT_DELAY_MS = 100;
const MAX_RECONNECT_DELAY_MS = 600_000;
const MAX_RECONNECT_ATTEMPTS = 100;
const MIN_INSTRUCTION_BYTES = 1_024;
const MAX_INSTRUCTION_BYTES = 1_048_576;

export interface CodedError extends Error {
  statusCode?: number;
  code?: string;
}

/** 构造带 HTTP 状态码与错误码的异常，路由层据此决定响应体。 */
export function coded(statusCode: number, code: string, message: string): CodedError {
  const error: CodedError = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

export function messageOf(caught: unknown): string {
  if (caught instanceof Error) return caught.message;
  if (typeof caught === "string") return caught;
  try {
    return JSON.stringify(caught);
  } catch {
    return String(caught);
  }
}

export interface ServerRecord {
  id: string;
  serverName: string;
  enabled: boolean;
  transport: Transport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  toolCallTimeoutMs?: number;
  /** 重连策略；缺省即全用上游默认。 */
  reconnect?: ReconnectPolicy;
  /** 服务器指令（instructions）的字节上限；缺省用上游 32768。 */
  maxInstructionBytes?: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoreFile {
  version: 1;
  servers: ServerRecord[];
}

/** 已归一化的用户输入（密钥已合并，可直接落盘）。 */
export interface ServerInput {
  serverName: string;
  transport: Transport;
  enabled: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  toolCallTimeoutMs?: number;
  reconnect?: ReconnectPolicy;
  maxInstructionBytes?: number;
}

export function resolveDshHome(): string {
  const fromEnvironment = process.env.DSH_HOME;
  return typeof fromEnvironment === "string" && fromEnvironment.trim() !== ""
    ? fromEnvironment
    : join(homedir(), ".dsh");
}

export function managerHomePath(): string {
  return join(resolveDshHome(), "mcp-manager");
}

export function storePath(): string {
  return join(managerHomePath(), "servers.json");
}

export function emptyStore(): StoreFile {
  return { version: 1, servers: [] };
}

/** 读取配置；文件不存在视为空配置，结构损坏则抛错（绝不静默覆盖）。 */
export async function readStore(file: string = storePath()): Promise<StoreFile> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw coded(500, "error.store.unreadable", `无法读取 ${file}：${messageOf(caught)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw coded(500, "error.store.corrupt", `${file} 不是合法 JSON；已停止写入以免覆盖原有配置`);
  }
  const store = normalizeStore(parsed);
  if (store === undefined) {
    throw coded(500, "error.store.corrupt", `${file} 结构不符合 v1 约定；已停止写入以免覆盖原有配置`);
  }
  return store;
}

/** 原子写：先写同目录临时文件再 rename，避免半截 JSON。 */
export async function writeStore(store: StoreFile, file: string = storePath()): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  } catch (caught) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw coded(500, "error.store.write", `无法写入 ${file}：${messageOf(caught)}`);
  }
  // 文件里可能有 token；Windows 上 chmod 是尽力而为。
  await chmod(file, 0o600).catch(() => undefined);
}

function normalizeStore(value: unknown): StoreFile | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as { version?: unknown; servers?: unknown };
  if (candidate.version !== 1 || !Array.isArray(candidate.servers)) return undefined;
  const servers: ServerRecord[] = [];
  for (const item of candidate.servers) {
    const record = normalizeRecord(item);
    if (record === undefined) return undefined;
    servers.push(record);
  }
  return { version: 1, servers };
}

function normalizeRecord(value: unknown): ServerRecord | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : undefined;
  const serverName = typeof raw.serverName === "string" ? raw.serverName : undefined;
  const transport = raw.transport === "stdio" || raw.transport === "streamable-http" ? raw.transport : undefined;
  if (id === undefined || serverName === undefined || transport === undefined) return undefined;
  if (!SERVER_NAME_PATTERN.test(serverName)) return undefined;
  return {
    id,
    serverName,
    transport,
    enabled: raw.enabled !== false,
    ...(typeof raw.command === "string" ? { command: raw.command } : {}),
    ...(Array.isArray(raw.args) ? { args: raw.args.filter((item): item is string => typeof item === "string") } : {}),
    ...(plainStrings(raw.env) ? { env: plainStrings(raw.env) } : {}),
    ...(typeof raw.cwd === "string" && raw.cwd !== "" ? { cwd: raw.cwd } : {}),
    ...(typeof raw.url === "string" && raw.url !== "" ? { url: raw.url } : {}),
    ...(plainStrings(raw.headers) ? { headers: plainStrings(raw.headers) } : {}),
    ...(typeof raw.toolCallTimeoutMs === "number" ? { toolCallTimeoutMs: raw.toolCallTimeoutMs } : {}),
    ...(readReconnect(raw.reconnect) === undefined ? {} : { reconnect: readReconnect(raw.reconnect) }),
    ...(typeof raw.maxInstructionBytes === "number" && raw.maxInstructionBytes > 0
      ? { maxInstructionBytes: raw.maxInstructionBytes }
      : {}),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
  };
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

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function keyValueObject(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw coded(400, "error.input." + field, `${field} 必须是键值对象`);
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const name = key.trim();
    if (name === "") continue;
    if (typeof item !== "string") throw coded(400, "error.input." + field, `${field}.${name} 必须是字符串`);
    if (/[\r\n]/.test(name) || /[\r\n]/.test(item)) {
      throw coded(400, "error.input." + field, `${field}.${name} 不能包含换行`);
    }
    out[name] = item;
  }
  return out;
}

function stringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw coded(400, "error.input." + field, `${field} 必须是字符串数组`);
  return value.map((item) => {
    if (typeof item !== "string") throw coded(400, "error.input." + field, `${field} 只能包含字符串`);
    return item;
  });
}

/** 读盘用：只认合法字段，不做严格范围校验，避免历史文件因上游默认值变化而读不出来。 */
function readReconnect(value: unknown): ReconnectPolicy | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const policy: ReconnectPolicy = {};
  if (typeof raw.enabled === "boolean") policy.enabled = raw.enabled;
  for (const key of ["initialDelayMs", "maxDelayMs", "maxAttempts"] as const) {
    const item = raw[key];
    if (typeof item === "number" && Number.isInteger(item) && item > 0) policy[key] = item;
  }
  return Object.keys(policy).length === 0 ? undefined : policy;
}

function integerInRange(value: unknown, min: number, max: number, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw coded(400, `error.input.${field}`, `${field} 必须是 ${min}~${max} 的整数`);
  }
  return parsed;
}

/** 请求体里的重连策略：逐字段校验，任何一项越界都整体拒绝，避免半套策略落盘。 */
function parseReconnect(value: unknown): ReconnectPolicy | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw coded(400, "error.input.reconnect", "reconnect 必须是对象");
  }
  const raw = value as Record<string, unknown>;
  const policy: ReconnectPolicy = {};
  if (typeof raw.enabled === "boolean") policy.enabled = raw.enabled;
  const initialDelayMs = integerInRange(
    raw.initialDelayMs,
    MIN_RECONNECT_DELAY_MS,
    MAX_RECONNECT_DELAY_MS,
    "reconnect.initialDelayMs",
  );
  if (initialDelayMs !== undefined) policy.initialDelayMs = initialDelayMs;
  const maxDelayMs = integerInRange(raw.maxDelayMs, MIN_RECONNECT_DELAY_MS, MAX_RECONNECT_DELAY_MS, "reconnect.maxDelayMs");
  if (maxDelayMs !== undefined) policy.maxDelayMs = maxDelayMs;
  const maxAttempts = integerInRange(raw.maxAttempts, 1, MAX_RECONNECT_ATTEMPTS, "reconnect.maxAttempts");
  if (maxAttempts !== undefined) policy.maxAttempts = maxAttempts;
  if (policy.initialDelayMs !== undefined && policy.maxDelayMs !== undefined && policy.maxDelayMs < policy.initialDelayMs) {
    throw coded(400, "error.input.reconnect", "重连最大延迟不能小于初始延迟");
  }
  return Object.keys(policy).length === 0 ? undefined : policy;
}

/** 校验并归一化请求体；失败抛 400（错误码给前端做本地化替换）。 */
export function parseInput(raw: unknown): ServerInput {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw coded(400, "error.input.body", "请求体必须是对象");
  }
  const body = raw as Record<string, unknown>;

  const serverName = text(body.serverName);
  if (serverName === undefined) throw coded(400, "error.input.serverName", "服务器名称不能为空");
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    throw coded(400, "error.input.serverName", "名称只能包含字母、数字、- 和 _，且不超过 32 个字符");
  }

  const transport = body.transport;
  if (transport !== "stdio" && transport !== "streamable-http") {
    throw coded(400, "error.input.transport", 'transport 必须是 "stdio" 或 "streamable-http"');
  }

  const timeout = body.toolCallTimeoutMs;
  let toolCallTimeoutMs: number | undefined;
  if (timeout !== undefined && timeout !== null && timeout !== "") {
    const parsed = typeof timeout === "number" ? timeout : Number(timeout);
    if (!Number.isInteger(parsed) || parsed < MIN_TOOL_CALL_TIMEOUT_MS || parsed > MAX_TOOL_CALL_TIMEOUT_MS) {
      throw coded(400, "error.input.timeout", `调用超时必须是 ${MIN_TOOL_CALL_TIMEOUT_MS}~${MAX_TOOL_CALL_TIMEOUT_MS} 的整数毫秒`);
    }
    toolCallTimeoutMs = parsed;
  }

  const enabled = body.enabled === undefined ? true : body.enabled !== false;

  const reconnect = parseReconnect(body.reconnect);
  const maxInstructionBytes = integerInRange(
    body.maxInstructionBytes,
    MIN_INSTRUCTION_BYTES,
    MAX_INSTRUCTION_BYTES,
    "maxInstructionBytes",
  );
  // 两种传输共用的可选字段，省一次重复。
  const extras = {
    ...(toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs }),
    ...(reconnect === undefined ? {} : { reconnect }),
    ...(maxInstructionBytes === undefined ? {} : { maxInstructionBytes }),
  };

  if (transport === "stdio") {
    const command = text(body.command);
    if (command === undefined) throw coded(400, "error.input.command", "stdio 传输必须填写命令");
    return {
      serverName,
      transport,
      enabled,
      command,
      args: stringList(body.args, "args") ?? [],
      env: keyValueObject(body.env, "env") ?? {},
      ...(text(body.cwd) === undefined ? {} : { cwd: text(body.cwd) }),
      ...extras,
    };
  }

  const url = text(body.url);
  if (url === undefined) throw coded(400, "error.input.url", "streamable-http 传输必须填写地址");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw coded(400, "error.input.url", `地址不是合法 URL：${url}`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw coded(400, "error.input.url", "地址只支持 http:// 或 https://");
  }
  return {
    serverName,
    transport,
    enabled,
    url: parsedUrl.href,
    headers: keyValueObject(body.headers, "headers") ?? {},
    ...extras,
  };
}

/**
 * 把输入合并成可落盘的记录。
 *
 * 密钥语义：`***` 或空字符串表示沿用旧值（前端拿不到明文，只能这样表达“不改”）；
 * 键被删掉则代表真的要删除。
 */
export function applyInput(input: ServerInput, previous?: ServerRecord): ServerRecord {
  const now = new Date().toISOString();
  const merge = (next?: Record<string, string>, old?: Record<string, string>) => {
    if (next === undefined) return old;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(next)) {
      if (value === SECRET_MASK || value === "") {
        if (old !== undefined && typeof old[key] === "string") out[key] = old[key];
        continue;
      }
      out[key] = value;
    }
    return out;
  };

  const base: ServerRecord = {
    id: previous?.id ?? randomUUID(),
    serverName: input.serverName,
    enabled: input.enabled,
    transport: input.transport,
    ...(input.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: input.toolCallTimeoutMs }),
    ...(input.reconnect === undefined ? {} : { reconnect: input.reconnect }),
    ...(input.maxInstructionBytes === undefined ? {} : { maxInstructionBytes: input.maxInstructionBytes }),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };

  if (input.transport === "stdio") {
    const env = merge(input.env, previous?.transport === "stdio" ? previous.env : undefined);
    return {
      ...base,
      command: input.command,
      args: input.args ?? [],
      ...(env === undefined ? {} : { env }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    };
  }

  const headers = merge(input.headers, previous?.transport === "streamable-http" ? previous.headers : undefined);
  return {
    ...base,
    url: input.url,
    ...(headers === undefined ? {} : { headers }),
  };
}

/** 回传前端前把密钥替换成占位符，只保留键名。 */
export function maskRecord(record: ServerRecord): ServerRecord {
  const mask = (source?: Record<string, string>) =>
    source === undefined
      ? undefined
      : Object.fromEntries(Object.keys(source).map((key) => [key, SECRET_MASK]));
  return {
    ...record,
    ...(record.env === undefined ? {} : { env: mask(record.env) }),
    ...(record.headers === undefined ? {} : { headers: mask(record.headers) }),
  };
}

/** 转成 `@deepseek-ai/dsh-mcp-client` 的配置；首次连接失败要显式报错，面板才有状态可显示。 */
export function toMcpConfig(record: ServerRecord): Record<string, unknown> {
  const common = {
    serverName: record.serverName,
    // 面板依赖 fiber 的 reject 展示失败状态，所以这里始终让启动错误冒出来。
    failOnStartupError: true,
    toolCallTimeoutMs: record.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
    ...(record.reconnect === undefined ? {} : { reconnect: record.reconnect }),
    ...(record.maxInstructionBytes === undefined ? {} : { maxInstructionBytes: record.maxInstructionBytes }),
  };
  if (record.transport === "stdio") {
    return {
      ...common,
      transport: "stdio",
      command: record.command,
      args: record.args ?? [],
      env: record.env ?? {},
      ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
    };
  }
  return {
    ...common,
    transport: "streamable-http",
    url: record.url,
    headers: record.headers ?? {},
  };
}
