import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { messageOf } from "./store.js";
const SECRET_MASK = "***";
const PLACEHOLDER = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;
function codebuddyMcpPath() {
  const override = process.env.DSMM_CODEBUDDY_MCP;
  if (typeof override === "string" && override.trim() !== "") return override;
  return join(homedir(), ".codebuddy", "mcp.json");
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
function stringList(value) {
  if (!Array.isArray(value)) return void 0;
  return value.every((item) => typeof item === "string") ? value : void 0;
}
function text(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
function normalize(name, value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
  const raw = value;
  const declared = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : void 0;
  const command = text(raw.command);
  const url = text(raw.url);
  let transport;
  if (command !== void 0) {
    transport = "stdio";
  } else if (url !== void 0) {
    transport = declared === "sse" ? "unsupported" : "streamable-http";
  } else {
    return void 0;
  }
  const env = plainStrings(raw.env);
  const headers = plainStrings(raw.headers);
  const args = stringList(raw.args);
  const cwd = text(raw.cwd);
  const placeholders = [];
  const scan = (field, candidate) => {
    if (candidate !== void 0 && PLACEHOLDER.test(candidate)) placeholders.push(field);
  };
  scan("command", command);
  scan("url", url);
  scan("cwd", cwd);
  if (args !== void 0) {
    args.forEach((argument, index) => scan(`args[${index}]`, argument));
  }
  for (const [key, item] of Object.entries(env ?? {})) scan(`env.${key}`, item);
  for (const [key, item] of Object.entries(headers ?? {})) scan(`headers.${key}`, item);
  return {
    name,
    transport,
    ...declared === void 0 ? {} : { rawType: declared },
    ...command === void 0 ? {} : { command },
    ...args === void 0 ? {} : { args },
    ...env === void 0 ? {} : { env },
    ...cwd === void 0 ? {} : { cwd },
    ...url === void 0 ? {} : { url },
    ...headers === void 0 ? {} : { headers },
    placeholders
  };
}
function mask(pairs) {
  if (pairs === void 0) return void 0;
  return Object.fromEntries(Object.keys(pairs).map((key) => [key, SECRET_MASK]));
}
function toDiscovered(server) {
  return {
    name: server.name,
    transport: server.transport,
    ...server.rawType === void 0 ? {} : { rawType: server.rawType },
    ...server.command === void 0 ? {} : { command: server.command },
    ...server.args === void 0 ? {} : { args: server.args },
    ...mask(server.env) === void 0 ? {} : { env: mask(server.env) },
    ...server.cwd === void 0 ? {} : { cwd: server.cwd },
    ...server.url === void 0 ? {} : { url: server.url },
    ...mask(server.headers) === void 0 ? {} : { headers: mask(server.headers) },
    importable: server.transport !== "unsupported",
    placeholders: server.placeholders
  };
}
async function readCodeBuddySource(file = codebuddyMcpPath()) {
  const empty = { id: "codebuddy", configPath: file, servers: {} };
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (caught) {
    if (caught.code === "ENOENT") return empty;
    return { ...empty, error: `\u65E0\u6CD5\u8BFB\u53D6 ${file}\uFF1A${messageOf(caught)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...empty, error: `${file} \u4E0D\u662F\u5408\u6CD5 JSON` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...empty, error: `${file} \u9876\u5C42\u5FC5\u987B\u662F\u5BF9\u8C61` };
  }
  const container = parsed.mcpServers;
  if (container === void 0) return empty;
  if (container === null || typeof container !== "object" || Array.isArray(container)) {
    return { ...empty, error: `${file} \u7684 mcpServers \u5FC5\u987B\u662F\u5BF9\u8C61` };
  }
  const servers = {};
  for (const [name, value] of Object.entries(container)) {
    const normalized = normalize(name, value);
    if (normalized !== void 0) servers[name] = normalized;
  }
  return { id: "codebuddy", configPath: file, servers };
}
export {
  codebuddyMcpPath,
  readCodeBuddySource,
  toDiscovered
};
