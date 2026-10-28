import * as React from "react";
import { Button, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";

import { resolveApiUrl } from "./api-base.js";
import type {
  ClientContext,
  DiscoveredTransport,
  ManagerState,
  Phase,
  SectionProps,
  ServerView,
  SourceGroup,
  SourceId,
  ToolView,
  Translate,
  Transport,
  UpdateInfo,
} from "./client-types.js";

/**
 * 设置页「MCP 服务器」面板。
 *
 * 只做三件事：列出服务器与状态、编辑表单、查看某个服务器公布的工具。
 * 所有写操作都走 Host 的 POST 路由（带自定义头），前端不碰文件系统。
 */

declare const __DSMM_VERSION__: string;

const h = React.createElement;
const NS = "mcp-manager";
const API_ROOT = "/api/dsh-mcp-manager";
const MUTATION_HEADERS = { "content-type": "application/json", "x-dsh-mcp-manager": "1" };
const GITHUB_URL = "https://github.com/Alinexia-max/dsh-mcp-manager";
const ISSUES_URL = `${GITHUB_URL}/issues`;

/**
 * 语义化版本比较：返回 1 表示 a 比 b 新，0 相同，-1 更旧。
 * 只比较数字段与前缀为 `-` 的预发布标记（正式版高于同号预发布），够用且不引依赖。
 */
function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const [core = "", prerelease = ""] = value.trim().replace(/^v/i, "").split("-", 2);
    return {
      numbers: core.split(".").map((part) => Number.parseInt(part, 10) || 0),
      prerelease,
    };
  };
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.numbers.length, right.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === "") return 1;
  if (right.prerelease === "") return -1;
  return left.prerelease > right.prerelease ? 1 : -1;
}

/** 标题行右侧三个链接按钮的图标（GitHub / 问题反馈 / 检查更新）。 */
function iconGitHub(): React.ReactElement {
  return h(
    "svg",
    {
      viewBox: "0 0 24 24",
      width: 16,
      height: 16,
      fill: "currentColor",
      "aria-hidden": "true",
      focusable: "false",
    },
    h("path", {
      d: "M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2.17c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.79 0c2.21-1.49 3.18-1.18 3.18-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.7 5.41-5.27 5.69.42.36.78 1.06.78 2.14v3.17c0 .31.21.68.79.56A11.51 11.51 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z",
    }),
  );
}

function iconExternal(): React.ReactElement {
  return h(
    "svg",
    {
      viewBox: "0 0 16 16",
      width: 16,
      height: 16,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.4,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      focusable: "false",
    },
    h("path", { d: "M9.2 2.8h4v4" }),
    h("path", { d: "M13.2 2.8 7.6 8.4" }),
    h("path", { d: "M12 9.6v3.2a.8.8 0 0 1-.8.8H3.2a.8.8 0 0 1-.8-.8V4.8a.8.8 0 0 1 .8-.8h3.2" }),
  );
}

function iconRefresh(): React.ReactElement {
  return h(
    "svg",
    {
      viewBox: "0 0 16 16",
      width: 16,
      height: 16,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.4,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      focusable: "false",
    },
    h("path", { d: "M13.4 6.2A5.4 5.4 0 1 0 13.4 10" }),
    h("path", { d: "M13.6 2.6v3.6H10" }),
  );
}

/** 两层机箱 + 指示灯的形状表；面板标题（React）与设置导航（DOM）共用一份。 */
const SERVER_ICON_SHAPES: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ["rect", { x: "3", y: "4", width: "18", height: "6", rx: "2" }],
  ["rect", { x: "3", y: "14", width: "18", height: "6", rx: "2" }],
  ["path", { d: "M7 7h.01" }],
  ["path", { d: "M7 17h.01" }],
];

/** 面板标题左侧的图标：两层机箱 + 指示灯，呼应“MCP 服务器”而非宿主的齿轮。 */
function iconServers(size = 20): React.ReactElement {
  return h(
    "svg",
    {
      viewBox: "0 0 24 24",
      width: size,
      height: size,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.6,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      focusable: "false",
    },
    SERVER_ICON_SHAPES.map(([tag, attrs], index) => h(tag, { key: index, ...attrs })),
  );
}

const DICT: Record<string, Record<string, string>> = {
  zh: {
    title: "MCP 服务器",
    desc: "连接 MCP 服务器后，它的工具会以 mcp__<服务器>__<工具> 出现在对话里。",
    "btn.add": "添加服务器",
    "btn.refresh": "刷新",
    "link.github": "GitHub",
    "link.feedback": "问题反馈",
    "link.update": "检查更新",
    "update.checking": "正在检查更新…",
    "update.latest": "已是最新版本 v{version}",
    "update.available": "发现新版本 v{version}",
    "update.open": "查看",
    "update.offline": "连不上 GitHub，稍后再试",
    "update.failed": "检查更新失败：{reason}",
    "toolbar.source": "来源",
    "toolbar.sourceAll": "全部来源",
    "toolbar.phase": "状态",
    "toolbar.phaseAll": "全部状态",
    "search.placeholder": "搜索服务器名称、命令或地址",
    "group.dsh": "DSH",
    "group.codebuddy": "CodeBuddy",
    "group.count": "{count} 个服务器",
    "group.readonly": "只读",
    "empty.filtered": "没有匹配的服务器。",
    "btn.import": "导入",
    "import.unsupportedType": "不支持 {type}",
    "import.placeholders": "含占位符：{names}",
    "transport.unsupported": "不支持的传输",
    "btn.save": "保存",
    "btn.cancel": "取消",
    "btn.close": "关闭",
    "btn.edit": "编辑",
    "btn.delete": "删除",
    "btn.enable": "启用",
    "btn.disable": "停用",
    "btn.reconnect": "重连",
    "btn.tools": "查看工具",
    "btn.confirm": "确定",
    empty: "还没有配置 MCP 服务器。",
    loading: "正在加载…",
    "status.ready": "已连接",
    "status.connecting": "连接中",
    "status.error": "连接失败",
    "status.disabled": "已停用",
    "status.external": "外部挂载",
    "field.serverName": "服务器名称",
    "field.serverName.hint": "用作工具名前缀；只允许字母、数字、- 和 _，最长 32 个字符",
    "field.transport": "传输方式",
    "field.command": "命令",
    "field.command.hint": "例如 npx、node 或可执行文件绝对路径",
    "field.args": "参数",
    "field.args.hint": "每行一个参数",
    "field.env": "环境变量",
    "field.env.hint": "每行 KEY=VALUE",
    "field.cwd": "工作目录（可选）",
    "field.url": "服务地址",
    "field.url.hint": "http:// 或 https:// 的 Streamable HTTP 端点",
    "field.headers": "请求头",
    "field.headers.hint": "每行 KEY=VALUE",
    "field.timeout": "调用超时（毫秒）",
    "field.timeout.hint": "留空使用默认 60000",
    "form.create": "添加 MCP 服务器",
    "form.edit": "编辑 MCP 服务器",
    "form.secretNote": "已保存的密钥显示为 ***；保持不变就继续保留 ***。",
    "transport.stdio": "stdio（本地进程）",
    "transport.http": "streamable-http（远程）",
    "tools.title": "工具 · {name}",
    "tools.empty": "该服务器还没有公布工具。",
    "tools.count": "{count} 个工具",
    "confirm.title": "删除服务器",
    "confirm.body": "删除后 {name} 的工具会立即从对话中移除，配置也会从文件里删掉。",
    "note.external": "由 profile 配置挂载，此处只读",
    "store.path": "配置文件：{path}",
    "error.serverName": "请填写服务器名称",
    "error.serverName.pattern": "名称只能包含字母、数字、- 和 _，最长 32 个字符",
    "error.command": "stdio 传输必须填写命令",
    "error.url": "streamable-http 传输必须填写 http(s) 地址",
    "error.timeout": "调用超时必须是 1000~600000 的整数",
  },
  en: {
    title: "MCP Servers",
    desc: "Once connected, an MCP server's tools appear in chat as mcp__<server>__<tool>.",
    "btn.add": "Add server",
    "btn.refresh": "Refresh",
    "link.github": "GitHub",
    "link.feedback": "Feedback",
    "link.update": "Check updates",
    "update.checking": "Checking for updates…",
    "update.latest": "Up to date · v{version}",
    "update.available": "New version v{version} available",
    "update.open": "View",
    "update.offline": "Cannot reach GitHub, try again later",
    "update.failed": "Update check failed: {reason}",
    "toolbar.source": "Source",
    "toolbar.sourceAll": "All sources",
    "toolbar.phase": "Status",
    "toolbar.phaseAll": "All states",
    "search.placeholder": "Search name, command or URL",
    "group.dsh": "DSH",
    "group.codebuddy": "CodeBuddy",
    "group.count": "{count} servers",
    "group.readonly": "Read-only",
    "empty.filtered": "No matching server.",
    "btn.import": "Import",
    "import.unsupportedType": "{type} unsupported",
    "import.placeholders": "Placeholders: {names}",
    "transport.unsupported": "Unsupported transport",
    "btn.save": "Save",
    "btn.cancel": "Cancel",
    "btn.close": "Close",
    "btn.edit": "Edit",
    "btn.delete": "Delete",
    "btn.enable": "Enable",
    "btn.disable": "Disable",
    "btn.reconnect": "Reconnect",
    "btn.tools": "View tools",
    "btn.confirm": "Confirm",
    empty: "No MCP server configured yet.",
    loading: "Loading…",
    "status.ready": "Connected",
    "status.connecting": "Connecting",
    "status.error": "Failed",
    "status.disabled": "Disabled",
    "status.external": "Mounted externally",
    "field.serverName": "Server name",
    "field.serverName.hint": "Used as the tool-name prefix; letters, digits, - and _ only, up to 32 chars",
    "field.transport": "Transport",
    "field.command": "Command",
    "field.command.hint": "For example npx, node, or an absolute executable path",
    "field.args": "Arguments",
    "field.args.hint": "One argument per line",
    "field.env": "Environment",
    "field.env.hint": "One KEY=VALUE per line",
    "field.cwd": "Working directory (optional)",
    "field.url": "Endpoint URL",
    "field.url.hint": "A Streamable HTTP endpoint using http:// or https://",
    "field.headers": "Headers",
    "field.headers.hint": "One KEY=VALUE per line",
    "field.timeout": "Call timeout (ms)",
    "field.timeout.hint": "Leave empty to use the 60000 default",
    "form.create": "Add MCP server",
    "form.edit": "Edit MCP server",
    "form.secretNote": "Stored secrets show as ***; keep *** to leave them unchanged.",
    "transport.stdio": "stdio (local process)",
    "transport.http": "streamable-http (remote)",
    "tools.title": "Tools · {name}",
    "tools.empty": "This server has not published any tool yet.",
    "tools.count": "{count} tools",
    "confirm.title": "Delete server",
    "confirm.body": "Deleting {name} removes its tools from chat immediately and drops the entry from disk.",
    "note.external": "Mounted by profile config; read-only here",
    "store.path": "Config file: {path}",
    "error.serverName": "Server name is required",
    "error.serverName.pattern": "Letters, digits, - and _ only, up to 32 chars",
    "error.command": "stdio transport requires a command",
    "error.url": "streamable-http transport requires an http(s) URL",
    "error.timeout": "Timeout must be an integer between 1000 and 600000",
  },
};

function format(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}

/** 宿主没注入 t 时的兜底：用内置中文词典，面板至少可读。 */
function fallbackTranslate(key: string, params?: Record<string, unknown>): string {
  const table = DICT.zh;
  const template = table[key] ?? key;
  return format(template, params);
}

function messageOf(caught: unknown): string {
  if (caught instanceof Error) return caught.message;
  if (caught !== null && typeof caught === "object" && "error" in caught) {
    const value = (caught as { error?: unknown }).error;
    if (typeof value === "string") return value;
  }
  return String(caught);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(resolveApiUrl(API_ROOT + path), init);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`服务端返回了非 JSON 响应（HTTP ${response.status}）`);
  }
  const envelope = payload as { ok?: boolean; data?: T; error?: unknown };
  if (!response.ok || envelope.ok === false) {
    throw new Error(typeof envelope.error === "string" ? envelope.error : `HTTP ${response.status}`);
  }
  return envelope.data as T;
}

function postJson<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: MUTATION_HEADERS,
    body: JSON.stringify(body ?? {}),
  });
}

interface Draft {
  id: string | null;
  serverName: string;
  transport: Transport;
  enabled: boolean;
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  headers: string;
  toolCallTimeoutMs: string;
}

function pairsToText(pairs?: Record<string, string>): string {
  if (pairs === undefined) return "";
  return Object.keys(pairs)
    .map((key) => `${key}=${pairs[key] ?? ""}`)
    .join("\n");
}

function textToPairs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const at = trimmed.indexOf("=");
    if (at <= 0) continue;
    out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return out;
}

function linesToText(lines?: string[]): string {
  return (lines ?? []).join("\n");
}

function textToLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function draftFrom(server: ServerView | null): Draft {
  if (server === null) {
    return {
      id: null,
      serverName: "",
      transport: "stdio",
      enabled: true,
      command: "",
      args: "",
      env: "",
      cwd: "",
      url: "",
      headers: "",
      toolCallTimeoutMs: "",
    };
  }
  return {
    id: server.id,
    serverName: server.serverName,
    transport: server.transport === "streamable-http" ? "streamable-http" : "stdio",
    enabled: server.enabled,
    command: server.command ?? "",
    args: linesToText(server.args),
    env: pairsToText(server.env),
    cwd: server.cwd ?? "",
    url: server.url ?? "",
    headers: pairsToText(server.headers),
    toolCallTimeoutMs: server.toolCallTimeoutMs === undefined ? "" : String(server.toolCallTimeoutMs),
  };
}

function payloadFrom(draft: Draft): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    serverName: draft.serverName.trim(),
    transport: draft.transport,
    enabled: draft.enabled,
  };
  if (draft.transport === "stdio") {
    payload.command = draft.command.trim();
    payload.args = textToLines(draft.args);
    payload.env = textToPairs(draft.env);
    if (draft.cwd.trim() !== "") payload.cwd = draft.cwd.trim();
  } else {
    payload.url = draft.url.trim();
    payload.headers = textToPairs(draft.headers);
  }
  if (draft.toolCallTimeoutMs.trim() !== "") payload.toolCallTimeoutMs = Number(draft.toolCallTimeoutMs);
  return payload;
}

function validate(draft: Draft, t: Translate): string | null {
  const serverName = draft.serverName.trim();
  if (serverName === "") return t("error.serverName");
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) return t("error.serverName.pattern");
  if (draft.transport === "stdio" && draft.command.trim() === "") return t("error.command");
  if (draft.transport === "streamable-http") {
    const url = draft.url.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) return t("error.url");
  }
  if (draft.toolCallTimeoutMs.trim() !== "") {
    const value = Number(draft.toolCallTimeoutMs);
    if (!Number.isInteger(value) || value < 1000 || value > 600000) return t("error.timeout");
  }
  return null;
}

function statusLabel(t: Translate, phase: ServerView["phase"]): string {
  switch (phase) {
    case "ready":
      return t("status.ready");
    case "connecting":
      return t("status.connecting");
    case "error":
      return t("status.error");
    case "external":
      return t("status.external");
    default:
      return t("status.disabled");
  }
}

function transportLabel(t: Translate, transport: DiscoveredTransport | "external"): string {
  if (transport === "stdio") return t("transport.stdio");
  if (transport === "streamable-http") return t("transport.http");
  if (transport === "unsupported") return t("transport.unsupported");
  return t("note.external");
}

export interface ServerFilter {
  keyword: string;
  source: SourceId | "all";
  phase: Phase | "all";
}

/** 面板的检索/过滤是纯前端行为，抽成纯函数便于测试。 */
function filterServers(servers: ServerView[], filter: ServerFilter): ServerView[] {
  const keyword = filter.keyword.trim().toLowerCase();
  return servers.filter((server) => {
    if (filter.source !== "all" && server.origin !== filter.source) return false;
    if (filter.phase !== "all" && server.phase !== filter.phase) return false;
    if (keyword === "") return true;
    const haystack = [
      server.serverName,
      server.command ?? "",
      (server.args ?? []).join(" "),
      server.url ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(keyword);
  });
}

/** 只读来源的一行：只能导入，不能编辑或启停。 */
function DiscoveredRow(props: {
  server: ServerView;
  t: Translate;
  busy: boolean;
  onImport: () => void;
}): React.ReactElement {
  const { server, t, busy } = props;
  const unsupported = server.importable === false;
  const detail =
    server.command === undefined || server.command === ""
      ? server.url ?? ""
      : `${server.command} ${linesToText(server.args)}`.trim();
  return h(
    "div",
    { className: "dsmm-row", "data-phase": "external" },
    h(
      "div",
      { className: "dsmm-row-main" },
      h(
        "div",
        { className: "dsmm-row-title" },
        h("span", { className: "dsmm-name" }, server.serverName),
        h("span", { className: "dsmm-meta" }, transportLabel(t, server.transport)),
        unsupported
          ? h(
              "span",
              { className: "dsmm-badge", "data-phase": "error" },
              format(t("import.unsupportedType"), { type: server.rawType ?? server.transport }),
            )
          : null,
        server.placeholders === undefined || server.placeholders.length === 0
          ? null
          : h(
              "span",
              { className: "dsmm-meta" },
              format(t("import.placeholders"), { names: server.placeholders.join(", ") }),
            ),
      ),
      detail === "" ? null : h("div", { className: "dsmm-command" }, detail),
    ),
    h(
      "div",
      { className: "dsmm-row-actions" },
      h(
        Button,
        { variant: "ghost", size: "sm", disabled: busy || unsupported, onClick: props.onImport },
        t("btn.import"),
      ),
    ),
  );
}

function Field(props: {
  label: string;
  hint?: string;
  children?: React.ReactNode;
}): React.ReactElement {
  return h(
    "label",
    { className: "dsmm-field" },
    h("span", { className: "dsmm-field-label" }, props.label),
    props.children,
    props.hint === undefined ? null : h("span", { className: "dsmm-field-hint" }, props.hint),
  );
}

function ServerRow(props: {
  server: ServerView;
  t: Translate;
  busy: boolean;
  onEdit: () => void;
  onTools: () => void;
  onToggle: () => void;
  onReconnect: () => void;
  onDelete: () => void;
}): React.ReactElement {
  const { server, t, busy } = props;
  const target = server.transport === "external" ? "" : server.transport;
  return h(
    "div",
    { className: "dsmm-row", "data-phase": server.phase },
    h(
      "div",
      { className: "dsmm-row-main" },
      h(
        "div",
        { className: "dsmm-row-title" },
        h("span", { className: "dsmm-name" }, server.serverName),
        h("span", { className: "dsmm-badge", "data-phase": server.phase }, statusLabel(t, server.phase)),
        server.transport === "external"
          ? h("span", { className: "dsmm-meta" }, t("note.external"))
          : h("span", { className: "dsmm-meta" }, target),
        h("span", { className: "dsmm-meta" }, format(t("tools.count"), { count: server.toolCount })),
      ),
      server.command === undefined || server.command === ""
        ? server.url === undefined
          ? null
          : h("div", { className: "dsmm-command" }, server.url)
        : h("div", { className: "dsmm-command" }, `${server.command} ${linesToText(server.args)}`.trim()),
      server.error === undefined ? null : h("div", { className: "dsmm-row-error" }, server.error),
    ),
    h(
      "div",
      { className: "dsmm-row-actions" },
      h(Button, { variant: "ghost", size: "sm", disabled: busy, onClick: props.onTools }, t("btn.tools")),
      server.external
        ? null
        : h(Button, { variant: "ghost", size: "sm", disabled: busy, onClick: props.onEdit }, t("btn.edit")),
      server.external || !server.enabled
        ? null
        : h(Button, { variant: "ghost", size: "sm", disabled: busy, onClick: props.onReconnect }, t("btn.reconnect")),
      server.external
        ? null
        : h(
            Button,
            { variant: "ghost", size: "sm", disabled: busy, onClick: props.onToggle },
            server.enabled ? t("btn.disable") : t("btn.enable"),
          ),
      server.external
        ? null
        : h(Button, { variant: "ghost", size: "sm", disabled: busy, onClick: props.onDelete }, t("btn.delete")),
    ),
  );
}

function ServerForm(props: {
  initial: Draft;
  t: Translate;
  busy: boolean;
  onClose: () => void;
  onSubmit: (draft: Draft) => void;
}): React.ReactElement {
  const { t } = props;
  const [draft, setDraft] = React.useState<Draft>(props.initial);
  const [localError, setLocalError] = React.useState<string | null>(null);

  function update(key: keyof Draft, value: string | boolean): void {
    setDraft(Object.assign({}, draft, { [key]: value }) as Draft);
  }

  function submit(): void {
    const invalid = validate(draft, t);
    if (invalid !== null) {
      setLocalError(invalid);
      return;
    }
    setLocalError(null);
    props.onSubmit(draft);
  }

  const transportButton = (value: Transport, label: string) =>
    h(
      Button,
      {
        variant: draft.transport === value ? "primary" : "ghost",
        size: "sm",
        onClick: () => update("transport", value),
        disabled: props.busy,
      },
      label,
    );

  return h(Modal, {
    open: true,
    onClose: props.onClose,
    title: props.initial.id === null ? t("form.create") : t("form.edit"),
    closeLabel: t("btn.close"),
    children: h(
      "div",
      { className: "dsmm-form" },
      h(
        "div",
        { className: "dsmm-form-grid" },
        h(
          Field,
          { label: t("field.serverName"), hint: t("field.serverName.hint") },
          h(Input, {
            value: draft.serverName,
            placeholder: "demo",
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => update("serverName", event.target.value),
          }),
        ),
        h(
          Field,
          { label: t("field.transport") },
          h(
            "div",
            { className: "dsmm-segmented" },
            transportButton("stdio", t("transport.stdio")),
            transportButton("streamable-http", t("transport.http")),
          ),
        ),
      ),
      draft.transport === "stdio"
        ? h(
            React.Fragment,
            null,
            h(
              Field,
              { label: t("field.command"), hint: t("field.command.hint") },
              h(Input, {
                value: draft.command,
                placeholder: "npx",
                onChange: (event: React.ChangeEvent<HTMLInputElement>) => update("command", event.target.value),
              }),
            ),
            h(
              Field,
              { label: t("field.args"), hint: t("field.args.hint") },
              h("textarea", {
                className: "dsmm-textarea",
                rows: 3,
                value: draft.args,
                placeholder: "-y\n@modelcontextprotocol/server-everything",
                onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => update("args", event.target.value),
              }),
            ),
            h(
              Field,
              { label: t("field.env"), hint: t("field.env.hint") },
              h("textarea", {
                className: "dsmm-textarea",
                rows: 3,
                value: draft.env,
                placeholder: "GITHUB_TOKEN=***",
                onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => update("env", event.target.value),
              }),
            ),
            h(
              Field,
              { label: t("field.cwd") },
              h(Input, {
                value: draft.cwd,
                onChange: (event: React.ChangeEvent<HTMLInputElement>) => update("cwd", event.target.value),
              }),
            ),
          )
        : h(
            React.Fragment,
            null,
            h(
              Field,
              { label: t("field.url"), hint: t("field.url.hint") },
              h(Input, {
                value: draft.url,
                placeholder: "http://127.0.0.1:3000/mcp",
                onChange: (event: React.ChangeEvent<HTMLInputElement>) => update("url", event.target.value),
              }),
            ),
            h(
              Field,
              { label: t("field.headers"), hint: t("field.headers.hint") },
              h("textarea", {
                className: "dsmm-textarea",
                rows: 3,
                value: draft.headers,
                placeholder: "Authorization=Bearer ***",
                onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => update("headers", event.target.value),
              }),
            ),
          ),
      h(
        "div",
        { className: "dsmm-form-grid" },
        h(
          Field,
          { label: t("field.timeout"), hint: t("field.timeout.hint") },
          h(Input, {
            value: draft.toolCallTimeoutMs,
            inputMode: "numeric",
            onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
              update("toolCallTimeoutMs", event.target.value),
          }),
        ),
      ),
      h("p", { className: "dsmm-note" }, t("form.secretNote")),
      localError === null ? null : h("div", { className: "dsmm-alert", role: "alert" }, localError),
    ),
    footer: h(
      "div",
      { className: "dsmm-form-footer" },
      h(Button, { variant: "ghost", onClick: props.onClose, disabled: props.busy }, t("btn.cancel")),
      h(Button, { variant: "primary", onClick: submit, disabled: props.busy }, t("btn.save")),
    ),
  });
}

function ToolsDialog(props: {
  server: ServerView;
  tools: ToolView[];
  t: Translate;
  onClose: () => void;
}): React.ReactElement {
  const { server, tools, t } = props;
  return h(Modal, {
    open: true,
    onClose: props.onClose,
    title: format(t("tools.title"), { name: server.serverName }),
    closeLabel: t("btn.close"),
    children: h(
      "div",
      { className: "dsmm-tools" },
      tools.length === 0
        ? h("div", { className: "dsmm-empty" }, t("tools.empty"))
        : tools.map((tool) =>
            h(
              "div",
              { className: "dsmm-tool", key: tool.name },
              h("div", { className: "dsmm-tool-name" }, tool.name),
              h("div", { className: "dsmm-tool-desc" }, tool.description === "" ? "—" : tool.description),
            ),
          ),
    ),
    footer: h(
      "div",
      { className: "dsmm-form-footer" },
      h(Button, { variant: "ghost", onClick: props.onClose }, t("btn.close")),
    ),
  });
}

/** 检查更新在标题区下方给出的一行反馈。 */
interface UpdateNote {
  tone: "busy" | "ok" | "new" | "warn";
  text: string;
  url?: string;
}

function Section(props: SectionProps): React.ReactElement {
  const t: Translate = typeof props?.t === "function" ? props.t : fallbackTranslate;
  const [state, setState] = React.useState<ManagerState | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [detail, setDetail] = React.useState<{ server: ServerView; tools: ToolView[] } | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<ServerView | null>(null);
  const [keyword, setKeyword] = React.useState("");
  const [sourceFilter, setSourceFilter] = React.useState<SourceId | "all">("all");
  const [phaseFilter, setPhaseFilter] = React.useState<Phase | "all">("all");
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const [update, setUpdate] = React.useState<UpdateNote | null>(null);
  const alive = React.useRef(true);

  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = React.useCallback((): Promise<void> => {
    return request<ManagerState>("")
      .then((next) => {
        if (!alive.current) return;
        setState(next);
        setError(next.storeError ?? null);
      })
      .catch((caught: unknown) => {
        if (alive.current) setError(messageOf(caught));
      });
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  function mutate(task: () => Promise<unknown>): Promise<boolean> {
    if (!alive.current) return Promise.resolve(false);
    setBusy(true);
    setError(null);
    return task()
      .then(() => refresh().then(() => true))
      .catch((caught: unknown) => {
        if (alive.current) setError(messageOf(caught));
        return false;
      })
      .then((ok) => {
        if (alive.current) setBusy(false);
        return ok;
      });
  }

  function openTools(server: ServerView): void {
    setBusy(true);
    request<ToolView[]>(`/servers/${encodeURIComponent(server.id)}/tools`)
      .then((tools) => {
        if (alive.current) setDetail({ server, tools });
      })
      .catch((caught: unknown) => {
        if (alive.current) setError(messageOf(caught));
      })
      .then(() => {
        if (alive.current) setBusy(false);
      });
  }

  function checkUpdate(): void {
    if (update !== null && update.tone === "busy") return;
    setUpdate({ tone: "busy", text: t("update.checking") });
    request<UpdateInfo>("/update?refresh=1")
      .then((info) => {
        if (!alive.current) return;
        if (info.source === "none" || info.latestVersion === null) {
          setUpdate({ tone: "warn", text: t("update.offline") });
          return;
        }
        if (compareVersions(info.latestVersion, __DSMM_VERSION__) <= 0) {
          setUpdate({ tone: "ok", text: format(t("update.latest"), { version: __DSMM_VERSION__ }) });
          return;
        }
        setUpdate({
          tone: "new",
          text: format(t("update.available"), { version: info.latestVersion }),
          url: info.url,
        });
      })
      .catch((caught: unknown) => {
        if (alive.current) setUpdate({ tone: "warn", text: format(t("update.failed"), { reason: messageOf(caught) }) });
      });
  }

  function submit(draftValue: Draft): void {
    const payload = payloadFrom(draftValue);
    const path =
      draftValue.id === null ? "/servers" : `/servers/${encodeURIComponent(draftValue.id)}/update`;
    void mutate(() => postJson(path, payload)).then((ok) => {
      if (ok) setDraft(null);
    });
  }

  function remove(server: ServerView): void {
    setPendingDelete(null);
    void mutate(() => postJson(`/servers/${encodeURIComponent(server.id)}/delete`));
  }

  function importServer(server: ServerView): void {
    void mutate(() => postJson("/import", { source: server.origin, name: server.serverName }));
  }

  const groups: SourceGroup[] = state === null ? [] : state.groups ?? [];

  const row = (server: ServerView) =>
    server.origin === "codebuddy"
      ? h(DiscoveredRow, {
          key: server.id,
          server,
          t,
          busy,
          onImport: () => importServer(server),
        })
      : h(ServerRow, {
          key: server.id,
          server,
          t,
          busy,
          onEdit: () => setDraft(draftFrom(server)),
          onTools: () => openTools(server),
          onToggle: () => {
            const action = server.enabled ? "disable" : "enable";
            void mutate(() => postJson(`/servers/${encodeURIComponent(server.id)}/${action}`));
          },
          onReconnect: () => {
            void mutate(() => postJson(`/servers/${encodeURIComponent(server.id)}/reconnect`));
          },
          onDelete: () => setPendingDelete(server),
        });

  const visibleGroups = groups
    .filter((group) => sourceFilter === "all" || group.id === sourceFilter)
    .map((group) => ({
      group,
      servers: filterServers(group.servers, { keyword, source: "all", phase: phaseFilter }),
    }))
    .filter(
      ({ servers }) =>
        servers.length > 0 ||
        // 没有搜索/过滤时保留空分组，让用户看得见来源与配置文件路径。
        (keyword.trim() === "" && phaseFilter === "all"),
    );

  const groupSection = (entry: { group: SourceGroup; servers: ServerView[] }) => {
    const { group, servers } = entry;
    const folded = collapsed[group.id] === true;
    return h(
      "section",
      { className: "dsmm-group", key: group.id, "data-source": group.id },
      h(
        "header",
        {
          className: "dsmm-group-head",
          role: "button",
          tabIndex: 0,
          "aria-expanded": !folded,
          onClick: () => setCollapsed({ ...collapsed, [group.id]: !folded }),
        },
        h("span", { className: "dsmm-group-caret", "aria-hidden": "true" }, folded ? "▸" : "▾"),
        h("span", { className: "dsmm-group-name" }, group.id === "dsh" ? t("group.dsh") : t("group.codebuddy")),
        h("span", { className: "dsmm-group-count" }, format(t("group.count"), { count: group.servers.length })),
        group.writable ? null : h("span", { className: "dsmm-group-tag" }, t("group.readonly")),
        h("span", { className: "dsmm-group-path", title: group.configPath }, group.configPath),
      ),
      folded
        ? null
        : group.error === undefined
          ? servers.length === 0
            ? h(
                "div",
                { className: "dsmm-empty" },
                keyword.trim() !== "" || phaseFilter !== "all" ? t("empty.filtered") : t("empty"),
              )
            : h("div", { className: "dsmm-list" }, servers.map(row))
          : h("div", { className: "dsmm-group-error", role: "alert" }, group.error),
    );
  };

  return h(
    React.Fragment,
    null,
    h("style", { key: "dsmm-style" }, CSS),
    h(
      "section",
      { className: "dsmm-root" },
      h(
        "header",
        { className: "dsmm-header" },
        h(
          "div",
          { className: "dsmm-heading" },
          h(
            "div",
            { className: "dsmm-title-row" },
            h("span", { className: "dsmm-title-icon", "aria-hidden": "true" }, iconServers()),
            h("h2", { className: "dsmm-title" }, t("title")),
            h("span", { className: "dsmm-version" }, `v${__DSMM_VERSION__}`),
            h(
              "div",
              { className: "dsmm-links" },
              h(
                Button,
                {
                  variant: "outline",
                  size: "sm",
                  icon: iconGitHub(),
                  "aria-label": t("link.github"),
                  onClick: () => window.open(GITHUB_URL, "_blank", "noreferrer"),
                },
                t("link.github"),
              ),
              h(
                Button,
                {
                  variant: "outline",
                  size: "sm",
                  icon: iconExternal(),
                  "aria-label": t("link.feedback"),
                  onClick: () => window.open(ISSUES_URL, "_blank", "noreferrer"),
                },
                t("link.feedback"),
              ),
              h(
                Button,
                {
                  variant: "outline",
                  size: "sm",
                  icon: iconRefresh(),
                  "aria-label": t("link.update"),
                  disabled: update !== null && update.tone === "busy",
                  onClick: checkUpdate,
                },
                t("link.update"),
              ),
            ),
          ),
          h("p", { className: "dsmm-desc" }, t("desc")),
          update === null
            ? null
            : h(
                "p",
                { className: "dsmm-update", "data-tone": update.tone, role: "status" },
                update.text,
                update.url === undefined
                  ? null
                  : h(
                      "a",
                      { className: "dsmm-update-link", href: update.url, target: "_blank", rel: "noreferrer" },
                      t("update.open"),
                    ),
              ),
        ),
        h(
          "div",
          { className: "dsmm-header-actions" },
          h(
            Button,
            {
              variant: "primary",
              disabled: busy || state === null,
              onClick: () => setDraft(draftFrom(null)),
            },
            t("btn.add"),
          ),
        ),
      ),
      h(
        "div",
        { className: "dsmm-toolbar" },
        h(
          "select",
          {
            className: "dsmm-select",
            "aria-label": t("toolbar.source"),
            value: sourceFilter,
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
              setSourceFilter(event.target.value as SourceId | "all"),
          },
          h("option", { value: "all" }, t("toolbar.sourceAll")),
          h("option", { value: "dsh" }, t("group.dsh")),
          h("option", { value: "codebuddy" }, t("group.codebuddy")),
        ),
        h(
          "select",
          {
            className: "dsmm-select",
            "aria-label": t("toolbar.phase"),
            value: phaseFilter,
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
              setPhaseFilter(event.target.value as Phase | "all"),
          },
          h("option", { value: "all" }, t("toolbar.phaseAll")),
          h("option", { value: "ready" }, t("status.ready")),
          h("option", { value: "connecting" }, t("status.connecting")),
          h("option", { value: "error" }, t("status.error")),
          h("option", { value: "disabled" }, t("status.disabled")),
          h("option", { value: "external" }, t("status.external")),
        ),
        h("input", {
          className: "dsmm-search",
          type: "search",
          "aria-label": t("search.placeholder"),
          placeholder: t("search.placeholder"),
          value: keyword,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setKeyword(event.target.value),
        }),
        h(Button, { variant: "ghost", size: "sm", disabled: busy, onClick: () => void refresh() }, t("btn.refresh")),
      ),
      error === null ? null : h("div", { className: "dsmm-alert", role: "alert" }, error),
      state === null
        ? h("div", { className: "dsmm-empty" }, t("loading"))
        : visibleGroups.length === 0
          ? h("div", { className: "dsmm-empty" }, t("empty.filtered"))
          : h("div", { className: "dsmm-groups" }, visibleGroups.map(groupSection)),
      state === null || state.storePath === ""
        ? null
        : h("p", { className: "dsmm-foot" }, format(t("store.path"), { path: state.storePath })),
    ),
    draft === null
      ? null
      : h(ServerForm, {
          initial: draft,
          t,
          busy,
          onClose: () => setDraft(null),
          onSubmit: submit,
        }),
    detail === null
      ? null
      : h(ToolsDialog, {
          server: detail.server,
          tools: detail.tools,
          t,
          onClose: () => setDetail(null),
        }),
    pendingDelete === null
      ? null
      : h(Modal, {
          open: true,
          onClose: () => setPendingDelete(null),
          title: t("confirm.title"),
          closeLabel: t("btn.close"),
          children: h(
            "p",
            { className: "dsmm-note" },
            format(t("confirm.body"), { name: pendingDelete.serverName }),
          ),
          footer: h(
            "div",
            { className: "dsmm-form-footer" },
            h(Button, { variant: "ghost", onClick: () => setPendingDelete(null) }, t("btn.cancel")),
            h(
              Button,
              { variant: "primary", onClick: () => remove(pendingDelete) },
              t("btn.confirm"),
            ),
          ),
        }),
  );
}

const CSS = `
.dsmm-root{display:flex;flex-direction:column;gap:12px;container-type:inline-size}
.dsmm-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dsmm-heading{display:flex;flex-direction:column;gap:0;min-width:0}
.dsmm-title-row{display:flex;align-items:center;gap:8px 12px;min-width:0;flex-wrap:wrap}
.dsmm-title-icon{display:flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;border-radius:var(--dsw-radius-md,10px);color:var(--dsw-alias-brand-primary,#4f8cff);background:var(--dsw-alias-bg-layer-1,#1c1c1c);border:0.5px solid var(--dsw-alias-border-l1,#2f2f2f)}
.dsmm-links{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:4px}
.dsmm-links svg{flex:none}
.dsmm-title{margin:0;font-size:24px;line-height:32px;font-weight:600;letter-spacing:-.4px;white-space:nowrap;color:var(--dsw-alias-label-primary,#eeeeee)}
.dsmm-version{margin-left:8px;font-size:12px;font-weight:500;line-height:18px;letter-spacing:0;white-space:nowrap;vertical-align:baseline;color:var(--dsw-alias-label-tertiary,#a0a0a0)}
.dsmm-desc{margin:12px 0 0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary,#a0a0a0)}
.dsmm-update{margin:8px 0 0;display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#a0a0a0)}
.dsmm-update[data-tone="new"]{color:var(--dsw-alias-brand-primary,#4f8cff)}
.dsmm-update[data-tone="warn"]{color:var(--dsw-alias-state-error-primary,#e5534b)}
.dsmm-update-link{color:inherit;text-decoration:underline;text-underline-offset:2px}
.dsmm-header-actions{display:flex;gap:8px;flex-wrap:wrap}
.dsmm-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsmm-select{height:32px;padding:0 8px;box-sizing:border-box;font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-1,#1c1c1c);border:0.5px solid var(--dsw-alias-border-l2,#3a3a3a);border-radius:var(--dsw-radius-sm,8px);cursor:pointer}
.dsmm-select:focus-visible,.dsmm-search:focus-visible{outline:var(--dsw-focus-ring-width,1px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#4f8cff));outline-offset:1px}
.dsmm-search{flex:1 1 180px;min-width:140px;height:32px;padding:0 10px;box-sizing:border-box;font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-1,#1c1c1c);border:0.5px solid var(--dsw-alias-border-l2,#3a3a3a);border-radius:var(--dsw-radius-sm,8px)}
.dsmm-search::placeholder{color:var(--dsw-alias-label-tertiary,#9a9a9a)}
.dsmm-groups{display:flex;flex-direction:column;gap:16px}
.dsmm-group{display:flex;flex-direction:column;gap:8px;min-width:0}
.dsmm-group-head{display:flex;align-items:center;gap:8px;padding:6px 4px;min-width:0;cursor:pointer;border-radius:var(--dsw-radius-sm,8px);user-select:none}
.dsmm-group-head:hover{background:var(--dsw-alias-bg-layer-1,#1c1c1c)}
.dsmm-group-head:focus-visible{outline:var(--dsw-focus-ring-width,1px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#4f8cff));outline-offset:1px}
.dsmm-group-caret{width:12px;flex:none;font-size:11px;line-height:1;color:var(--dsw-alias-label-tertiary,#9a9a9a)}
.dsmm-group-name{flex:none;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsmm-group-count{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#9a9a9a)}
.dsmm-group-tag{flex:none;padding:0 6px;border-radius:999px;font-size:10px;line-height:16px;border:0.5px solid var(--dsw-alias-border-l2,#3a3a3a);color:var(--dsw-alias-label-tertiary,#9a9a9a)}
.dsmm-group-path{margin-left:auto;min-width:0;font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-tertiary,#9a9a9a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsmm-group-error{padding:8px 12px;border-radius:var(--dsw-radius-sm,8px);font-size:11px;line-height:1.5;color:var(--dsw-alias-state-error-primary,#e5534b);border:0.5px solid currentColor;word-break:break-word}
.dsmm-list{display:flex;flex-direction:column;border:0.5px solid var(--dsw-alias-border-l2,#3a3a3a);border-radius:var(--dsw-radius-lg,16px);overflow:hidden}
.dsmm-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:12px 14px;border-top:0.5px solid var(--dsw-alias-border-l1,#2f2f2f)}
.dsmm-row:first-child{border-top:none}
.dsmm-row-main{display:flex;flex-direction:column;gap:4px;min-width:0}
.dsmm-row-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsmm-name{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsmm-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#9a9a9a)}
.dsmm-command{font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary,#b8b8b8);word-break:break-all}
.dsmm-row-error{font-size:11px;line-height:1.5;color:var(--dsw-alias-state-error-primary,#e5534b);word-break:break-word}
.dsmm-row-actions{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}
.dsmm-badge{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;font-size:11px;line-height:18px;border:0.5px solid var(--dsw-alias-border-l2,#3a3a3a);color:var(--dsw-alias-label-secondary,#b8b8b8)}
.dsmm-badge[data-phase="ready"]{color:var(--dsw-alias-state-success-primary,#3fb950);border-color:currentColor}
.dsmm-badge[data-phase="connecting"]{color:var(--dsw-alias-state-warn-primary,#d29922);border-color:currentColor}
.dsmm-badge[data-phase="error"]{color:var(--dsw-alias-state-error-primary,#e5534b);border-color:currentColor}
.dsmm-badge[data-phase="external"]{color:var(--dsw-alias-link,#6cb6ff);border-color:currentColor}
.dsmm-empty{padding:24px 16px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary,#9a9a9a);border:0.5px dashed var(--dsw-alias-border-l2,#3a3a3a);border-radius:var(--dsw-radius-lg,16px)}
.dsmm-alert{padding:8px 12px;border-radius:var(--dsw-radius-sm,8px);font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary,#e5534b);background:var(--dsw-alias-bg-layer-1,#1c1c1c);border:0.5px solid currentColor;word-break:break-word}
.dsmm-foot{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary,#9a9a9a);word-break:break-all}
.dsmm-form{display:flex;flex-direction:column;gap:12px}
.dsmm-form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.dsmm-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.dsmm-field-label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsmm-field-hint{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-tertiary,#9a9a9a)}
.dsmm-segmented{display:flex;gap:6px;flex-wrap:wrap}
.dsmm-textarea{width:100%;box-sizing:border-box;padding:8px 10px;font-size:12px;line-height:1.5;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-1,#1c1c1c);border:0.5px solid var(--dsw-alias-border-l2,#3a3a3a);border-radius:var(--dsw-radius-sm,8px);resize:vertical}
.dsmm-textarea:focus-visible{outline:var(--dsw-focus-ring-width,1px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#4f8cff));outline-offset:1px}
.dsmm-note{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#9a9a9a)}
.dsmm-form-footer{display:flex;justify-content:flex-end;gap:8px}
.dsmm-tools{display:flex;flex-direction:column;gap:8px;max-height:50vh;overflow:auto}
.dsmm-tool{padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l1,#2f2f2f);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1,#1c1c1c)}
.dsmm-tool-name{font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-primary,#e6e6e6);word-break:break-all}
.dsmm-tool-desc{margin-top:2px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#9a9a9a)}
@container(max-width:520px){.dsmm-row{flex-direction:column}.dsmm-row-actions{justify-content:flex-start}}
@media(prefers-reduced-motion:no-preference){.dsmm-row{transition:background-color .12s ease}.dsmm-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.04))}}
`;

const inject = ["slots", "locale"];

/** 宿主设置导航行的 CSS Modules 类名后缀；宿主改版导致选择器落空时补丁静默失效。 */
const NAV_CELL_SELECTOR = '[class*="_navCell"]';
const NAV_LABEL_SELECTOR = '[class*="_navLabel"]';
const NAV_ICON_SELECTOR = '[class*="_navIcon"]';
const NAV_PATCHED_ATTR = "data-dsmm-nav-icon";

/** 用同一份形状表造 DOM 版图标；尺寸与 class 沿用被替换的宿主图标，配色跟随主题。 */
function createServerIcon(size: string | null, className: string | null): SVGElement {
  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size ?? "16");
  svg.setAttribute("height", size ?? "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (className !== null) svg.setAttribute("class", className);
  for (const [tag, attrs] of SERVER_ICON_SHAPES) {
    const shape = document.createElementNS(svgNs, tag);
    for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, value);
    svg.appendChild(shape);
  }
  return svg;
}

/**
 * 宿主按 section id 硬编码设置导航图标（未知 id 一律用齿轮），注册项没有 icon 字段，
 * 因此只能在客户端把本分区那一行的齿轮换成服务器图标：按导航文本定位行，替换行内 svg。
 * 面板本体不依赖这段补丁，选择器失配时只是保留宿主默认图标。
 */
function patchSettingsNavIcon(): () => void {
  const noop = () => undefined;
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return noop;
  const titles = new Set([DICT.zh.title, DICT.en.title]);
  const patch = () => {
    for (const label of Array.from(document.querySelectorAll(NAV_LABEL_SELECTOR))) {
      if (!titles.has((label.textContent ?? "").trim())) continue;
      const cell = label.closest(NAV_CELL_SELECTOR);
      if (cell === null) continue;
      const icons = Array.from(cell.querySelectorAll(NAV_ICON_SELECTOR));
      const patched = icons.find((node) => node.getAttribute(NAV_PATCHED_ATTR) === "1");
      if (patched !== undefined) {
        // React 重渲染可能把宿主齿轮塞回来；保留补丁图标，删掉复发的那一个。
        for (const node of icons) if (node !== patched) node.remove();
        continue;
      }
      const original = icons[0];
      if (original === undefined) continue;
      const replacement = createServerIcon(original.getAttribute("width"), original.getAttribute("class"));
      replacement.setAttribute(NAV_PATCHED_ATTR, "1");
      original.replaceWith(replacement);
      for (const node of icons.slice(1)) node.remove();
    }
  };
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      patch();
    });
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body ?? document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  patch();
  return () => observer.disconnect();
}

function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, DICT), "mcp-manager: locale");
  ctx.effect(() => patchSettingsNavIcon(), "mcp-manager: settings nav icon");
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "mcp-manager",
        order: 24,
        label: () => ctx.locale.bind(NS)("title"),
        locale: NS,
        inject: () => ({ t: ctx.locale.bind(NS) }),
      },
      Section,
    ),
  );
}

module.exports.apply = apply;
module.exports.inject = inject;
module.exports.DICT = DICT;
module.exports.resolveApiUrl = resolveApiUrl;
module.exports.parsePairs = textToPairs;
module.exports.payloadFrom = payloadFrom;
module.exports.validate = validate;
module.exports.draftFrom = draftFrom;
module.exports.filterServers = filterServers;
module.exports.compareVersions = compareVersions;
