import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readCodeBuddySource, toDiscovered } from "./discovery.js";
import {
  applyInput,
  coded,
  maskRecord,
  messageOf,
  parseInput,
  readStore,
  SERVER_NAME_PATTERN,
  storePath,
  toMcpConfig,
  writeStore
} from "./store.js";
const MCP_CLIENT_PACKAGE = "@deepseek-ai/dsh-mcp-client";
const TOOL_PREFIX = "mcp__";
function createSupervisor(options) {
  const { ctx, autostart, log } = options;
  const statuses = /* @__PURE__ */ new Map();
  const mounted = /* @__PURE__ */ new Map();
  let records = [];
  let storeError;
  let loadError;
  let modulePromise;
  let resolveReady = () => void 0;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  let operations = Promise.resolve();
  function serial(task) {
    const queued = operations.then(task, task);
    operations = queued.catch(() => void 0);
    return queued;
  }
  function toolSchemas() {
    try {
      return ctx.tools?.schemas?.() ?? [];
    } catch {
      return [];
    }
  }
  function parseToolName(name) {
    if (!name.startsWith(TOOL_PREFIX)) return void 0;
    const rest = name.slice(TOOL_PREFIX.length);
    const at = rest.indexOf("__");
    if (at <= 0) return void 0;
    return { server: rest.slice(0, at), raw: rest.slice(at + 2) };
  }
  function toolCounts() {
    const counts = /* @__PURE__ */ new Map();
    for (const schema of toolSchemas()) {
      const parsed = parseToolName(schema.name);
      if (parsed === void 0) continue;
      counts.set(parsed.server, (counts.get(parsed.server) ?? 0) + 1);
    }
    return counts;
  }
  async function loadModule() {
    if (modulePromise !== void 0) return modulePromise;
    modulePromise = (async () => {
      const bases = [];
      let profileDir;
      try {
        const facts = ctx.profileContext;
        if (facts !== void 0 && typeof facts.dir === "string") profileDir = facts.dir;
      } catch {
        profileDir = void 0;
      }
      if (profileDir !== void 0 && profileDir !== "") bases.push(join(profileDir, "package.json"));
      const cliEntry = process.argv[1];
      if (typeof cliEntry === "string" && cliEntry !== "") bases.push(cliEntry);
      bases.push(join(process.cwd(), "package.json"));
      bases.push(import.meta.url);
      const failures = [];
      for (const base of bases) {
        try {
          const resolver = createRequire(base);
          const resolved = resolver.resolve(MCP_CLIENT_PACKAGE);
          return await import(pathToFileURL(resolved).href);
        } catch (caught) {
          failures.push(`${base}: ${messageOf(caught)}`);
        }
      }
      const error = coded(
        503,
        "error.mount.resolve",
        `\u65E0\u6CD5\u52A0\u8F7D ${MCP_CLIENT_PACKAGE}\uFF0C\u8BF7\u5728\u5BBF\u4E3B profile \u91CC\u5B89\u88C5\u540E\u518D\u8BD5\uFF08${failures.join(" | ")}\uFF09`
      );
      loadError = error.message;
      throw error;
    })();
    modulePromise.catch(() => {
      modulePromise = void 0;
    });
    return modulePromise;
  }
  async function doMount(record) {
    statuses.set(record.id, { phase: "connecting" });
    let fiber;
    try {
      if (typeof ctx.plugin !== "function") {
        throw coded(500, "error.mount.unsupported", "\u5BBF\u4E3B\u6CA1\u6709\u63D0\u4F9B ctx.plugin\uFF0C\u65E0\u6CD5\u52A8\u6001\u6302\u8F7D MCP \u5BA2\u6237\u7AEF");
      }
      const module = await loadModule();
      fiber = ctx.plugin(module, toMcpConfig(record));
    } catch (caught) {
      statuses.set(record.id, { phase: "error", error: messageOf(caught) });
      return;
    }
    const dispose = async () => {
      try {
        await fiber.dispose?.();
      } catch {
      }
    };
    mounted.set(record.id, { fiber, dispose });
    void Promise.resolve(fiber).then(
      () => {
        if (mounted.get(record.id)?.fiber !== fiber) return;
        statuses.set(record.id, { phase: "ready" });
      },
      (caught) => {
        if (mounted.get(record.id)?.fiber !== fiber) return;
        mounted.delete(record.id);
        statuses.set(record.id, { phase: "error", error: messageOf(caught) });
        void dispose();
      }
    );
  }
  function mount(record) {
    return serial(async () => {
      await doUnmount(record.id);
      await doMount(record);
    });
  }
  async function doUnmount(id) {
    const entry = mounted.get(id);
    mounted.delete(id);
    statuses.delete(id);
    if (entry !== void 0) await entry.dispose();
  }
  function unmount(id) {
    return serial(() => doUnmount(id));
  }
  function find(id) {
    const record = records.find((item) => item.id === id);
    if (record === void 0) throw coded(404, "error.server.notFound", `\u670D\u52A1\u5668\u4E0D\u5B58\u5728\uFF1A${id}`);
    return record;
  }
  function viewOf(record) {
    const status = statuses.get(record.id);
    const phase = !record.enabled ? "disabled" : status?.phase ?? "disabled";
    return {
      ...maskRecord(record),
      phase,
      ...status?.error === void 0 ? {} : { error: status.error },
      toolCount: toolCounts().get(record.serverName) ?? 0,
      external: false,
      origin: "dsh"
    };
  }
  function views() {
    return records.map(viewOf);
  }
  function externalViews() {
    const known = new Set(records.map((record) => record.serverName));
    const grouped = /* @__PURE__ */ new Map();
    for (const schema of toolSchemas()) {
      const parsed = parseToolName(schema.name);
      if (parsed === void 0 || known.has(parsed.server)) continue;
      grouped.set(parsed.server, (grouped.get(parsed.server) ?? 0) + 1);
    }
    return [...grouped.entries()].map(([serverName, count]) => ({
      id: `external:${serverName}`,
      serverName,
      transport: "external",
      enabled: true,
      phase: "external",
      toolCount: count,
      createdAt: "",
      updatedAt: "",
      external: true,
      origin: "dsh"
    }));
  }
  function discoveredView(source, server) {
    return {
      id: `${source}:${server.name}`,
      serverName: server.name,
      transport: server.transport,
      enabled: false,
      phase: "external",
      toolCount: 0,
      ...server.command === void 0 ? {} : { command: server.command },
      ...server.args === void 0 ? {} : { args: server.args },
      ...server.env === void 0 ? {} : { env: server.env },
      ...server.cwd === void 0 ? {} : { cwd: server.cwd },
      ...server.url === void 0 ? {} : { url: server.url },
      ...server.headers === void 0 ? {} : { headers: server.headers },
      createdAt: "",
      updatedAt: "",
      external: true,
      origin: source,
      importable: server.importable,
      placeholders: server.placeholders,
      ...server.rawType === void 0 ? {} : { rawType: server.rawType }
    };
  }
  async function readSources() {
    try {
      return await readCodeBuddySource();
    } catch (caught) {
      return {
        id: "codebuddy",
        configPath: "",
        servers: {},
        error: messageOf(caught)
      };
    }
  }
  function groupsOf(codebuddy) {
    const dsh = {
      id: "dsh",
      configPath: storePath(),
      writable: true,
      servers: [...views(), ...externalViews()],
      ...storeError === void 0 ? {} : { error: storeError }
    };
    const external = {
      id: "codebuddy",
      configPath: codebuddy.configPath,
      writable: false,
      servers: Object.values(codebuddy.servers).map(
        (server) => discoveredView("codebuddy", toDiscovered(server))
      ),
      ...codebuddy.error === void 0 ? {} : { error: codebuddy.error }
    };
    return [dsh, external];
  }
  function assertWritable() {
    if (storeError !== void 0) {
      throw coded(409, "error.store.corrupt", `\u914D\u7F6E\u6587\u4EF6\u4E0D\u53EF\u7528\uFF0C\u5DF2\u62D2\u7EDD\u5199\u5165\uFF1A${storeError}`);
    }
  }
  async function persist() {
    assertWritable();
    await writeStore({ version: 1, servers: records });
  }
  function assertNameAvailable(serverName, ignoreId) {
    const lower = serverName.toLowerCase();
    if (records.some((record) => record.id !== ignoreId && record.serverName.toLowerCase() === lower)) {
      throw coded(409, "error.server.duplicate", `\u5DF2\u6709\u540C\u540D\u670D\u52A1\u5668\uFF1A${serverName}`);
    }
    const prefix = `${TOOL_PREFIX}${serverName}__`;
    if (toolSchemas().some((schema) => schema.name.startsWith(prefix))) {
      throw coded(409, "error.server.toolConflict", `\u5DE5\u5177\u540D\u524D\u7F00 ${prefix} \u5DF2\u88AB\u5360\u7528\uFF0C\u8BF7\u6362\u4E00\u4E2A\u670D\u52A1\u5668\u540D\u79F0`);
    }
  }
  async function bootstrap() {
    try {
      const store = await readStore();
      records = store.servers;
    } catch (caught) {
      storeError = messageOf(caught);
      log(`[mcp-manager] ${storeError}`);
    } finally {
      resolveReady();
    }
    if (storeError !== void 0 || !autostart) return;
    for (const record of records.filter((item) => item.enabled)) void mount(record);
  }
  void bootstrap();
  return {
    ready,
    async state() {
      await ready;
      const external = externalViews();
      const codebuddy = await readSources();
      return {
        storePath: storePath(),
        servers: views(),
        external,
        groups: groupsOf(codebuddy),
        ...storeError === void 0 ? {} : { storeError }
      };
    },
    async list() {
      await ready;
      return views();
    },
    async tools(id) {
      await ready;
      const record = find(id);
      const prefix = `${TOOL_PREFIX}${record.serverName}__`;
      return toolSchemas().filter((schema) => schema.name.startsWith(prefix)).map((schema) => ({
        name: schema.name,
        rawName: schema.name.slice(prefix.length),
        description: schema.description ?? "",
        ...schema.parameters === void 0 ? {} : { parameters: schema.parameters }
      }));
    },
    async create(raw) {
      await ready;
      assertWritable();
      const input = parseInput(raw);
      if (loadError !== void 0) log(`[mcp-manager] ${loadError}`);
      assertNameAvailable(input.serverName);
      const record = applyInput(input);
      records = [...records, record];
      await persist();
      if (record.enabled) await mount(record);
      return viewOf(record);
    },
    async update(id, raw) {
      await ready;
      assertWritable();
      const previous = find(id);
      const input = parseInput(raw);
      if (input.serverName !== previous.serverName) assertNameAvailable(input.serverName, id);
      const next = applyInput(input, previous);
      records = records.map((record) => record.id === id ? next : record);
      await persist();
      if (previous.enabled) await unmount(id);
      if (next.enabled) await mount(next);
      return viewOf(next);
    },
    async remove(id) {
      await ready;
      assertWritable();
      find(id);
      await unmount(id);
      records = records.filter((record) => record.id !== id);
      await persist();
    },
    async setEnabled(id, enabled) {
      await ready;
      assertWritable();
      const previous = find(id);
      if (previous.enabled === enabled) return viewOf(previous);
      const next = { ...previous, enabled, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
      records = records.map((record) => record.id === id ? next : record);
      await persist();
      if (enabled) await mount(next);
      else await unmount(id);
      return viewOf(next);
    },
    async reconnect(id) {
      await ready;
      const record = find(id);
      if (!record.enabled) throw coded(409, "error.server.disabled", "\u670D\u52A1\u5668\u5DF2\u505C\u7528\uFF0C\u8BF7\u5148\u542F\u7528");
      await mount(record);
      return viewOf(record);
    },
    async importServer(raw) {
      await ready;
      assertWritable();
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw coded(400, "error.import.body", "\u8BF7\u6C42\u4F53\u5FC5\u987B\u662F\u5BF9\u8C61");
      }
      const body = raw;
      const source = body.source;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (source !== "codebuddy") {
        throw coded(400, "error.import.source", `\u4E0D\u652F\u6301\u7684\u6765\u6E90\uFF1A${String(source)}`);
      }
      if (name === "") throw coded(400, "error.import.name", "\u8BF7\u6307\u5B9A\u8981\u5BFC\u5165\u7684\u670D\u52A1\u5668\u540D\u79F0");
      if (!SERVER_NAME_PATTERN.test(name)) {
        throw coded(
          400,
          "error.import.namePattern",
          `\u540D\u79F0 ${name} \u4E0D\u80FD\u76F4\u63A5\u7528\u4F5C\u670D\u52A1\u5668\u540D\uFF08\u53EA\u5141\u8BB8\u5B57\u6BCD\u3001\u6570\u5B57\u3001- \u548C _\uFF0C\u6700\u957F 32 \u4E2A\u5B57\u7B26\uFF09`
        );
      }
      const snapshot = await readCodeBuddySource();
      if (snapshot.error !== void 0) throw coded(409, "error.import.unreadable", snapshot.error);
      const entry = snapshot.servers[name];
      if (entry === void 0) {
        throw coded(404, "error.import.notFound", `${snapshot.configPath} \u91CC\u6CA1\u6709\u540D\u4E3A ${name} \u7684\u670D\u52A1\u5668`);
      }
      if (entry.transport === "unsupported") {
        throw coded(
          400,
          "error.import.unsupported",
          `${name} \u4F7F\u7528 ${entry.rawType ?? "\u672A\u77E5"} \u4F20\u8F93\uFF0CDSH \u53EA\u652F\u6301 stdio \u4E0E streamable-http`
        );
      }
      assertNameAvailable(name);
      const input = parseInput({
        serverName: name,
        transport: entry.transport,
        enabled: true,
        ...entry.command === void 0 ? {} : { command: entry.command },
        ...entry.args === void 0 ? {} : { args: entry.args },
        ...entry.env === void 0 ? {} : { env: entry.env },
        ...entry.cwd === void 0 ? {} : { cwd: entry.cwd },
        ...entry.url === void 0 ? {} : { url: entry.url },
        ...entry.headers === void 0 ? {} : { headers: entry.headers }
      });
      const record = applyInput(input);
      records = [...records, record];
      await persist();
      if (record.enabled) await mount(record);
      return viewOf(record);
    },
    async dispose() {
      await ready;
      const ids = [...mounted.keys()];
      for (const id of ids) await unmount(id);
    }
  };
}
export {
  createSupervisor
};
