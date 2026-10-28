import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
const SECRET_MASK = "***";
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 6e4;
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const MIN_TOOL_CALL_TIMEOUT_MS = 1e3;
const MAX_TOOL_CALL_TIMEOUT_MS = 6e5;
function coded(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
function messageOf(caught) {
  if (caught instanceof Error) return caught.message;
  if (typeof caught === "string") return caught;
  try {
    return JSON.stringify(caught);
  } catch {
    return String(caught);
  }
}
function resolveDshHome() {
  const fromEnvironment = process.env.DSH_HOME;
  return typeof fromEnvironment === "string" && fromEnvironment.trim() !== "" ? fromEnvironment : join(homedir(), ".dsh");
}
function managerHomePath() {
  return join(resolveDshHome(), "mcp-manager");
}
function storePath() {
  return join(managerHomePath(), "servers.json");
}
function emptyStore() {
  return { version: 1, servers: [] };
}
async function readStore(file = storePath()) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (caught) {
    if (caught.code === "ENOENT") return emptyStore();
    throw coded(500, "error.store.unreadable", `\u65E0\u6CD5\u8BFB\u53D6 ${file}\uFF1A${messageOf(caught)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw coded(500, "error.store.corrupt", `${file} \u4E0D\u662F\u5408\u6CD5 JSON\uFF1B\u5DF2\u505C\u6B62\u5199\u5165\u4EE5\u514D\u8986\u76D6\u539F\u6709\u914D\u7F6E`);
  }
  const store = normalizeStore(parsed);
  if (store === void 0) {
    throw coded(500, "error.store.corrupt", `${file} \u7ED3\u6784\u4E0D\u7B26\u5408 v1 \u7EA6\u5B9A\uFF1B\u5DF2\u505C\u6B62\u5199\u5165\u4EE5\u514D\u8986\u76D6\u539F\u6709\u914D\u7F6E`);
  }
  return store;
}
async function writeStore(store, file = storePath()) {
  await mkdir(dirname(file), { recursive: true, mode: 448 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}
`, { encoding: "utf8", mode: 384 });
    await rename(temporary, file);
  } catch (caught) {
    await rm(temporary, { force: true }).catch(() => void 0);
    throw coded(500, "error.store.write", `\u65E0\u6CD5\u5199\u5165 ${file}\uFF1A${messageOf(caught)}`);
  }
  await chmod(file, 384).catch(() => void 0);
}
function normalizeStore(value) {
  if (value === null || typeof value !== "object") return void 0;
  const candidate = value;
  if (candidate.version !== 1 || !Array.isArray(candidate.servers)) return void 0;
  const servers = [];
  for (const item of candidate.servers) {
    const record = normalizeRecord(item);
    if (record === void 0) return void 0;
    servers.push(record);
  }
  return { version: 1, servers };
}
function normalizeRecord(value) {
  if (value === null || typeof value !== "object") return void 0;
  const raw = value;
  const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : void 0;
  const serverName = typeof raw.serverName === "string" ? raw.serverName : void 0;
  const transport = raw.transport === "stdio" || raw.transport === "streamable-http" ? raw.transport : void 0;
  if (id === void 0 || serverName === void 0 || transport === void 0) return void 0;
  if (!SERVER_NAME_PATTERN.test(serverName)) return void 0;
  return {
    id,
    serverName,
    transport,
    enabled: raw.enabled !== false,
    ...typeof raw.command === "string" ? { command: raw.command } : {},
    ...Array.isArray(raw.args) ? { args: raw.args.filter((item) => typeof item === "string") } : {},
    ...plainStrings(raw.env) ? { env: plainStrings(raw.env) } : {},
    ...typeof raw.cwd === "string" && raw.cwd !== "" ? { cwd: raw.cwd } : {},
    ...typeof raw.url === "string" && raw.url !== "" ? { url: raw.url } : {},
    ...plainStrings(raw.headers) ? { headers: plainStrings(raw.headers) } : {},
    ...typeof raw.toolCallTimeoutMs === "number" ? { toolCallTimeoutMs: raw.toolCallTimeoutMs } : {},
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : (/* @__PURE__ */ new Date()).toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : (/* @__PURE__ */ new Date()).toISOString()
  };
}
function plainStrings(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return void 0;
    out[key] = item;
  }
  return out;
}
function text(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
function keyValueObject(value, field) {
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw coded(400, "error.input." + field, `${field} \u5FC5\u987B\u662F\u952E\u503C\u5BF9\u8C61`);
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const name = key.trim();
    if (name === "") continue;
    if (typeof item !== "string") throw coded(400, "error.input." + field, `${field}.${name} \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`);
    if (/[\r\n]/.test(name) || /[\r\n]/.test(item)) {
      throw coded(400, "error.input." + field, `${field}.${name} \u4E0D\u80FD\u5305\u542B\u6362\u884C`);
    }
    out[name] = item;
  }
  return out;
}
function stringList(value, field) {
  if (value === void 0 || value === null) return void 0;
  if (!Array.isArray(value)) throw coded(400, "error.input." + field, `${field} \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4`);
  return value.map((item) => {
    if (typeof item !== "string") throw coded(400, "error.input." + field, `${field} \u53EA\u80FD\u5305\u542B\u5B57\u7B26\u4E32`);
    return item;
  });
}
function parseInput(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw coded(400, "error.input.body", "\u8BF7\u6C42\u4F53\u5FC5\u987B\u662F\u5BF9\u8C61");
  }
  const body = raw;
  const serverName = text(body.serverName);
  if (serverName === void 0) throw coded(400, "error.input.serverName", "\u670D\u52A1\u5668\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A");
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    throw coded(400, "error.input.serverName", "\u540D\u79F0\u53EA\u80FD\u5305\u542B\u5B57\u6BCD\u3001\u6570\u5B57\u3001- \u548C _\uFF0C\u4E14\u4E0D\u8D85\u8FC7 32 \u4E2A\u5B57\u7B26");
  }
  const transport = body.transport;
  if (transport !== "stdio" && transport !== "streamable-http") {
    throw coded(400, "error.input.transport", 'transport \u5FC5\u987B\u662F "stdio" \u6216 "streamable-http"');
  }
  const timeout = body.toolCallTimeoutMs;
  let toolCallTimeoutMs;
  if (timeout !== void 0 && timeout !== null && timeout !== "") {
    const parsed = typeof timeout === "number" ? timeout : Number(timeout);
    if (!Number.isInteger(parsed) || parsed < MIN_TOOL_CALL_TIMEOUT_MS || parsed > MAX_TOOL_CALL_TIMEOUT_MS) {
      throw coded(400, "error.input.timeout", `\u8C03\u7528\u8D85\u65F6\u5FC5\u987B\u662F ${MIN_TOOL_CALL_TIMEOUT_MS}~${MAX_TOOL_CALL_TIMEOUT_MS} \u7684\u6574\u6570\u6BEB\u79D2`);
    }
    toolCallTimeoutMs = parsed;
  }
  const enabled = body.enabled === void 0 ? true : body.enabled !== false;
  if (transport === "stdio") {
    const command = text(body.command);
    if (command === void 0) throw coded(400, "error.input.command", "stdio \u4F20\u8F93\u5FC5\u987B\u586B\u5199\u547D\u4EE4");
    return {
      serverName,
      transport,
      enabled,
      command,
      args: stringList(body.args, "args") ?? [],
      env: keyValueObject(body.env, "env") ?? {},
      ...text(body.cwd) === void 0 ? {} : { cwd: text(body.cwd) },
      ...toolCallTimeoutMs === void 0 ? {} : { toolCallTimeoutMs }
    };
  }
  const url = text(body.url);
  if (url === void 0) throw coded(400, "error.input.url", "streamable-http \u4F20\u8F93\u5FC5\u987B\u586B\u5199\u5730\u5740");
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw coded(400, "error.input.url", `\u5730\u5740\u4E0D\u662F\u5408\u6CD5 URL\uFF1A${url}`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw coded(400, "error.input.url", "\u5730\u5740\u53EA\u652F\u6301 http:// \u6216 https://");
  }
  return {
    serverName,
    transport,
    enabled,
    url: parsedUrl.href,
    headers: keyValueObject(body.headers, "headers") ?? {},
    ...toolCallTimeoutMs === void 0 ? {} : { toolCallTimeoutMs }
  };
}
function applyInput(input, previous) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const merge = (next, old) => {
    if (next === void 0) return old;
    const out = {};
    for (const [key, value] of Object.entries(next)) {
      if (value === SECRET_MASK || value === "") {
        if (old !== void 0 && typeof old[key] === "string") out[key] = old[key];
        continue;
      }
      out[key] = value;
    }
    return out;
  };
  const base = {
    id: previous?.id ?? randomUUID(),
    serverName: input.serverName,
    enabled: input.enabled,
    transport: input.transport,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now
  };
  if (input.transport === "stdio") {
    const env = merge(input.env, previous?.transport === "stdio" ? previous.env : void 0);
    return {
      ...base,
      command: input.command,
      args: input.args ?? [],
      ...env === void 0 ? {} : { env },
      ...input.cwd === void 0 ? {} : { cwd: input.cwd },
      ...input.toolCallTimeoutMs === void 0 ? {} : { toolCallTimeoutMs: input.toolCallTimeoutMs }
    };
  }
  const headers = merge(input.headers, previous?.transport === "streamable-http" ? previous.headers : void 0);
  return {
    ...base,
    url: input.url,
    ...headers === void 0 ? {} : { headers },
    ...input.toolCallTimeoutMs === void 0 ? {} : { toolCallTimeoutMs: input.toolCallTimeoutMs }
  };
}
function maskRecord(record) {
  const mask = (source) => source === void 0 ? void 0 : Object.fromEntries(Object.keys(source).map((key) => [key, SECRET_MASK]));
  return {
    ...record,
    ...record.env === void 0 ? {} : { env: mask(record.env) },
    ...record.headers === void 0 ? {} : { headers: mask(record.headers) }
  };
}
function toMcpConfig(record) {
  const common = {
    serverName: record.serverName,
    failOnStartupError: true,
    toolCallTimeoutMs: record.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS
  };
  if (record.transport === "stdio") {
    return {
      ...common,
      transport: "stdio",
      command: record.command,
      args: record.args ?? [],
      env: record.env ?? {},
      ...record.cwd === void 0 ? {} : { cwd: record.cwd }
    };
  }
  return {
    ...common,
    transport: "streamable-http",
    url: record.url,
    headers: record.headers ?? {}
  };
}
export {
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  SECRET_MASK,
  SERVER_NAME_PATTERN,
  applyInput,
  coded,
  emptyStore,
  managerHomePath,
  maskRecord,
  messageOf,
  parseInput,
  readStore,
  resolveDshHome,
  storePath,
  toMcpConfig,
  writeStore
};
