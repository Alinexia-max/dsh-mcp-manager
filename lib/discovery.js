import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { messageOf } from "./store.js";
const SECRET_MASK = "***";
const PLACEHOLDER = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;
function envPath(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() !== "" ? value : void 0;
}
function configHome() {
  if (process.platform === "win32") return envPath("APPDATA") ?? join(homedir(), "AppData", "Roaming");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  return join(homedir(), ".config");
}
function codebuddyMcpPath() {
  return envPath("DSMM_CODEBUDDY_MCP") ?? join(homedir(), ".codebuddy", "mcp.json");
}
function sourceDefinitions() {
  return [
    { id: "codebuddy", path: codebuddyMcpPath(), containerKeys: ["mcpServers"] },
    {
      id: "claude",
      path: envPath("DSMM_CLAUDE_MCP") ?? join(configHome(), "Claude", "claude_desktop_config.json"),
      containerKeys: ["mcpServers"]
    },
    {
      id: "cursor",
      path: envPath("DSMM_CURSOR_MCP") ?? join(homedir(), ".cursor", "mcp.json"),
      containerKeys: ["mcpServers"]
    },
    {
      id: "vscode",
      path: envPath("DSMM_VSCODE_MCP") ?? join(configHome(), "Code", "User", "mcp.json"),
      containerKeys: ["servers", "mcpServers"]
    }
  ];
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
function extractServers(parsed, containerKeys) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { servers: {}, error: "\u9876\u5C42\u5FC5\u987B\u662F\u5BF9\u8C61" };
  }
  const root = parsed;
  for (const key of containerKeys) {
    const container = root[key];
    if (container === void 0) continue;
    if (container === null || typeof container !== "object" || Array.isArray(container)) {
      return { servers: {}, error: `${key} \u5FC5\u987B\u662F\u5BF9\u8C61` };
    }
    const servers = {};
    for (const [name, value] of Object.entries(container)) {
      const normalized = normalize(name, value);
      if (normalized !== void 0) servers[name] = normalized;
    }
    return { servers };
  }
  return { servers: {} };
}
async function readSource(definition) {
  const file = definition.path;
  const empty = { id: definition.id, configPath: file, servers: {}, existing: false };
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (caught) {
    if (caught.code === "ENOENT") return empty;
    return { ...empty, existing: true, error: `\u65E0\u6CD5\u8BFB\u53D6 ${file}\uFF1A${messageOf(caught)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...empty, existing: true, error: `${file} \u4E0D\u662F\u5408\u6CD5 JSON` };
  }
  const extracted = extractServers(parsed, definition.containerKeys);
  if (extracted.error !== void 0) {
    return { ...empty, existing: true, error: `${file} \u7684 ${extracted.error}` };
  }
  return { id: definition.id, configPath: file, servers: extracted.servers, existing: true };
}
async function readAllSources() {
  return Promise.all(sourceDefinitions().map((definition) => readSource(definition)));
}
async function readCodeBuddySource(file = codebuddyMcpPath()) {
  return readSource({ id: "codebuddy", path: file, containerKeys: ["mcpServers"] });
}
function parseMcpConfig(text2) {
  let parsed;
  try {
    parsed = JSON.parse(text2);
  } catch (caught) {
    return { servers: {}, error: `\u4E0D\u662F\u5408\u6CD5 JSON\uFF1A${messageOf(caught)}` };
  }
  return extractServers(parsed, ["mcpServers", "servers"]);
}
export {
  codebuddyMcpPath,
  parseMcpConfig,
  readAllSources,
  readCodeBuddySource,
  readSource,
  sourceDefinitions,
  toDiscovered
};
