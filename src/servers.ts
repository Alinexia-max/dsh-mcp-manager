import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { DiscoveredServer, DiscoveredTransport, SourceGroup, SourceId } from "./client-types.js";
import type { HostContext, PluginFiber, ToolSchema } from "./host-types.js";
import { readCodeBuddySource, toDiscovered, type RawSource } from "./discovery.js";
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
  writeStore,
  type ServerInput,
  type ServerRecord,
  type Transport,
} from "./store.js";

/**
 * MCP 服务器监管器。
 *
 * 为什么自己持有 fiber：宿主没有查询「某个 MCP 服务器是否在线」的接口，mcp-client 的
 * 连接状态也不对外暴露；我们自己 `ctx.plugin()` 挂载后，fiber 的 resolve/reject 就是
 * 唯一权威的状态信号。
 */

export type Phase = "disabled" | "connecting" | "ready" | "error" | "external";

export interface ServerView {
  id: string;
  serverName: string;
  transport: DiscoveredTransport | "external";
  enabled: boolean;
  phase: Phase;
  error?: string;
  toolCount: number;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  toolCallTimeoutMs?: number;
  createdAt: string;
  updatedAt: string;
  external: boolean;
  /** 条目来源；`codebuddy` 的条目只读，只能导入。 */
  origin: SourceId;
  importable?: boolean;
  placeholders?: string[];
  /** 外部来源里原始的 `type`，用于说明为什么不可导入。 */
  rawType?: string;
}

export interface ToolView {
  name: string;
  rawName: string;
  description: string;
  parameters?: unknown;
}

export interface ManagerState {
  storePath: string;
  servers: ServerView[];
  external: ServerView[];
  /** 按来源分组；面板用它渲染，旧字段保留以兼容既有调用方。 */
  groups: SourceGroup[];
  storeError?: string;
}

export interface Supervisor {
  /** 首次读取配置完成后 resolve；路由层据此避免读到空数组。 */
  ready: Promise<void>;
  state(): Promise<ManagerState>;
  list(): Promise<ServerView[]>;
  tools(id: string): Promise<ToolView[]>;
  create(raw: unknown): Promise<ServerView>;
  update(id: string, raw: unknown): Promise<ServerView>;
  remove(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<ServerView>;
  reconnect(id: string): Promise<ServerView>;
  /** 把只读来源里的一条配置复制成本地服务器；密钥由服务端重新读原文取得。 */
  importServer(raw: unknown): Promise<ServerView>;
  dispose(): Promise<void>;
}

export interface SupervisorOptions {
  ctx: HostContext;
  /** 是否在启动时自动重连已启用的服务器（面板本身始终可用）。 */
  autostart: boolean;
  log: (message: string) => void;
}

const MCP_CLIENT_PACKAGE = "@deepseek-ai/dsh-mcp-client";
const TOOL_PREFIX = "mcp__";

interface Mounted {
  fiber: PluginFiber;
  dispose: () => Promise<void>;
}

export function createSupervisor(options: SupervisorOptions): Supervisor {
  const { ctx, autostart, log } = options;

  const statuses = new Map<string, { phase: Phase; error?: string }>();
  const mounted = new Map<string, Mounted>();
  let records: ServerRecord[] = [];
  let storeError: string | undefined;
  let loadError: string | undefined;
  let modulePromise: Promise<unknown> | undefined;
  let resolveReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  /** 所有挂载/卸载串行执行，避免同一台服务器被两个请求同时 mount。 */
  let operations: Promise<unknown> = Promise.resolve();
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const queued = operations.then(task, task);
    operations = queued.catch(() => undefined);
    return queued;
  }

  function toolSchemas(): ToolSchema[] {
    try {
      return ctx.tools?.schemas?.() ?? [];
    } catch {
      return [];
    }
  }

  /** 从 `mcp__<server>__<tool>` 里拆出服务器名与原始工具名。 */
  function parseToolName(name: string): { server: string; raw: string } | undefined {
    if (!name.startsWith(TOOL_PREFIX)) return undefined;
    const rest = name.slice(TOOL_PREFIX.length);
    const at = rest.indexOf("__");
    if (at <= 0) return undefined;
    return { server: rest.slice(0, at), raw: rest.slice(at + 2) };
  }

  function toolCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const schema of toolSchemas()) {
      const parsed = parseToolName(schema.name);
      if (parsed === undefined) continue;
      counts.set(parsed.server, (counts.get(parsed.server) ?? 0) + 1);
    }
    return counts;
  }

  /**
   * 解析 mcp-client 模块。
   *
   * 必须优先从 profile 目录解析：解析到第二份副本会让 serverName 冲突检测（模块内
   * WeakMap）失效，并且同名工具会在 ctx.tools 里重复注册直接报错。
   */
  async function loadModule(): Promise<unknown> {
    if (modulePromise !== undefined) return modulePromise;
    modulePromise = (async () => {
      const bases: string[] = [];
      // Cordis 的 ctx 是服务代理：未注册时读取可能抛错，所以这里按“可选服务”处理。
      let profileDir: string | undefined;
      try {
        const facts = ctx.profileContext;
        if (facts !== undefined && typeof facts.dir === "string") profileDir = facts.dir;
      } catch {
        profileDir = undefined;
      }
      if (profileDir !== undefined && profileDir !== "") bases.push(join(profileDir, "package.json"));
      // dsh CLI 自身依赖 mcp-client（apps/cli/package.json），从 CLI 入口解析可救回
      // “profile 里没装、但宿主进程能加载” 的部署形态。
      const cliEntry = process.argv[1];
      if (typeof cliEntry === "string" && cliEntry !== "") bases.push(cliEntry);
      bases.push(join(process.cwd(), "package.json"));
      bases.push(import.meta.url);

      const failures: string[] = [];
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
        `无法加载 ${MCP_CLIENT_PACKAGE}，请在宿主 profile 里安装后再试（${failures.join(" | ")}）`,
      );
      loadError = error.message;
      throw error;
    })();
    // 失败后允许重试（例如用户刚装好宿主依赖）。
    modulePromise.catch(() => {
      modulePromise = undefined;
    });
    return modulePromise;
  }

  async function doMount(record: ServerRecord): Promise<void> {
    statuses.set(record.id, { phase: "connecting" });
    let fiber: PluginFiber;
    try {
      if (typeof ctx.plugin !== "function") {
        throw coded(500, "error.mount.unsupported", "宿主没有提供 ctx.plugin，无法动态挂载 MCP 客户端");
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
        // 卸载失败不应阻塞后续操作。
      }
    };
    mounted.set(record.id, { fiber, dispose });

    void Promise.resolve(fiber as unknown as PromiseLike<unknown>).then(
      () => {
        if (mounted.get(record.id)?.fiber !== fiber) return;
        statuses.set(record.id, { phase: "ready" });
      },
      (caught: unknown) => {
        if (mounted.get(record.id)?.fiber !== fiber) return;
        mounted.delete(record.id);
        statuses.set(record.id, { phase: "error", error: messageOf(caught) });
        void dispose();
      },
    );
  }

  function mount(record: ServerRecord): Promise<void> {
    return serial(async () => {
      await doUnmount(record.id);
      await doMount(record);
    });
  }

  async function doUnmount(id: string): Promise<void> {
    const entry = mounted.get(id);
    mounted.delete(id);
    statuses.delete(id);
    if (entry !== undefined) await entry.dispose();
  }

  function unmount(id: string): Promise<void> {
    return serial(() => doUnmount(id));
  }

  function find(id: string): ServerRecord {
    const record = records.find((item) => item.id === id);
    if (record === undefined) throw coded(404, "error.server.notFound", `服务器不存在：${id}`);
    return record;
  }

  function viewOf(record: ServerRecord): ServerView {
    const status = statuses.get(record.id);
    const phase: Phase = !record.enabled ? "disabled" : status?.phase ?? "disabled";
    return {
      ...maskRecord(record),
      phase,
      ...(status?.error === undefined ? {} : { error: status.error }),
      toolCount: toolCounts().get(record.serverName) ?? 0,
      external: false,
      origin: "dsh",
    };
  }

  function views(): ServerView[] {
    return records.map(viewOf);
  }

  /** 由 profile 里的 Loader row 挂载的服务器：只能看，不能改。 */
  function externalViews(): ServerView[] {
    const known = new Set(records.map((record) => record.serverName));
    const grouped = new Map<string, number>();
    for (const schema of toolSchemas()) {
      const parsed = parseToolName(schema.name);
      if (parsed === undefined || known.has(parsed.server)) continue;
      grouped.set(parsed.server, (grouped.get(parsed.server) ?? 0) + 1);
    }
    return [...grouped.entries()].map(([serverName, count]) => ({
      id: `external:${serverName}`,
      serverName,
      transport: "external" as const,
      enabled: true,
      phase: "external" as const,
      toolCount: count,
      createdAt: "",
      updatedAt: "",
      external: true,
      origin: "dsh" as const,
    }));
  }

  /** 只读来源的条目：统一成 ServerView 形态，但不参与挂载与持久化。 */
  function discoveredView(source: SourceId, server: DiscoveredServer): ServerView {
    return {
      id: `${source}:${server.name}`,
      serverName: server.name,
      transport: server.transport,
      enabled: false,
      phase: "external",
      toolCount: 0,
      ...(server.command === undefined ? {} : { command: server.command }),
      ...(server.args === undefined ? {} : { args: server.args }),
      ...(server.env === undefined ? {} : { env: server.env }),
      ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
      ...(server.url === undefined ? {} : { url: server.url }),
      ...(server.headers === undefined ? {} : { headers: server.headers }),
      createdAt: "",
      updatedAt: "",
      external: true,
      origin: source,
      importable: server.importable,
      placeholders: server.placeholders,
      ...(server.rawType === undefined ? {} : { rawType: server.rawType }),
    };
  }

  async function readSources(): Promise<RawSource> {
    try {
      return await readCodeBuddySource();
    } catch (caught) {
      return {
        id: "codebuddy",
        configPath: "",
        servers: {},
        error: messageOf(caught),
      };
    }
  }

  /** DSH 自己的记录 + profile 外部挂载；CodeBuddy 侧全部只读。 */
  function groupsOf(codebuddy: RawSource): SourceGroup[] {
    const dsh: SourceGroup = {
      id: "dsh",
      configPath: storePath(),
      writable: true,
      servers: [...views(), ...externalViews()],
      ...(storeError === undefined ? {} : { error: storeError }),
    };
    const external: SourceGroup = {
      id: "codebuddy",
      configPath: codebuddy.configPath,
      writable: false,
      servers: Object.values(codebuddy.servers).map((server) =>
        discoveredView("codebuddy", toDiscovered(server)),
      ),
      ...(codebuddy.error === undefined ? {} : { error: codebuddy.error }),
    };
    return [dsh, external];
  }

  function assertWritable(): void {
    if (storeError !== undefined) {
      throw coded(409, "error.store.corrupt", `配置文件不可用，已拒绝写入：${storeError}`);
    }
  }

  async function persist(): Promise<void> {
    assertWritable();
    await writeStore({ version: 1, servers: records });
  }

  function assertNameAvailable(serverName: string, ignoreId?: string): void {
    const lower = serverName.toLowerCase();
    if (records.some((record) => record.id !== ignoreId && record.serverName.toLowerCase() === lower)) {
      throw coded(409, "error.server.duplicate", `已有同名服务器：${serverName}`);
    }
    const prefix = `${TOOL_PREFIX}${serverName}__`;
    if (toolSchemas().some((schema) => schema.name.startsWith(prefix))) {
      throw coded(409, "error.server.toolConflict", `工具名前缀 ${prefix} 已被占用，请换一个服务器名称`);
    }
  }

  async function bootstrap(): Promise<void> {
    try {
      const store = await readStore();
      records = store.servers;
    } catch (caught) {
      storeError = messageOf(caught);
      log(`[mcp-manager] ${storeError}`);
    } finally {
      resolveReady();
    }
    if (storeError !== undefined || !autostart) return;
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
        ...(storeError === undefined ? {} : { storeError }),
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
      return toolSchemas()
        .filter((schema) => schema.name.startsWith(prefix))
        .map((schema) => ({
          name: schema.name,
          rawName: schema.name.slice(prefix.length),
          description: schema.description ?? "",
          ...(schema.parameters === undefined ? {} : { parameters: schema.parameters }),
        }));
    },

    async create(raw) {
      await ready;
      assertWritable();
      const input: ServerInput = parseInput(raw);
      if (loadError !== undefined) log(`[mcp-manager] ${loadError}`);
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
      records = records.map((record) => (record.id === id ? next : record));
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
      const next: ServerRecord = { ...previous, enabled, updatedAt: new Date().toISOString() };
      records = records.map((record) => (record.id === id ? next : record));
      await persist();
      if (enabled) await mount(next);
      else await unmount(id);
      return viewOf(next);
    },

    async reconnect(id) {
      await ready;
      const record = find(id);
      if (!record.enabled) throw coded(409, "error.server.disabled", "服务器已停用，请先启用");
      await mount(record);
      return viewOf(record);
    },

    async importServer(raw) {
      await ready;
      assertWritable();
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw coded(400, "error.import.body", "请求体必须是对象");
      }
      const body = raw as Record<string, unknown>;
      const source = body.source;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (source !== "codebuddy") {
        throw coded(400, "error.import.source", `不支持的来源：${String(source)}`);
      }
      if (name === "") throw coded(400, "error.import.name", "请指定要导入的服务器名称");
      // 对方的键名会变成 mcp__<name>__<tool> 的前缀，不能带点号等字符。
      if (!SERVER_NAME_PATTERN.test(name)) {
        throw coded(
          400,
          "error.import.namePattern",
          `名称 ${name} 不能直接用作服务器名（只允许字母、数字、- 和 _，最长 32 个字符）`,
        );
      }

      const snapshot = await readCodeBuddySource();
      if (snapshot.error !== undefined) throw coded(409, "error.import.unreadable", snapshot.error);
      const entry = snapshot.servers[name];
      if (entry === undefined) {
        throw coded(404, "error.import.notFound", `${snapshot.configPath} 里没有名为 ${name} 的服务器`);
      }
      if (entry.transport === "unsupported") {
        throw coded(
          400,
          "error.import.unsupported",
          `${name} 使用 ${entry.rawType ?? "未知"} 传输，DSH 只支持 stdio 与 streamable-http`,
        );
      }

      assertNameAvailable(name);
      // 这里是服务端直接读到的真实值（前端只拿到过 ***），不需要掩码合并。
      const input = parseInput({
        serverName: name,
        transport: entry.transport,
        enabled: true,
        ...(entry.command === undefined ? {} : { command: entry.command }),
        ...(entry.args === undefined ? {} : { args: entry.args }),
        ...(entry.env === undefined ? {} : { env: entry.env }),
        ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
        ...(entry.url === undefined ? {} : { url: entry.url }),
        ...(entry.headers === undefined ? {} : { headers: entry.headers }),
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
    },
  };
}
