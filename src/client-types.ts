import type * as React from "react";

/** 面板里的取词函数；宿主通过 slot 的 inject 传入绑定到本插件命名空间的版本。 */
export type Translate = (key: string, params?: Record<string, unknown>) => string;

export type Transport = "stdio" | "streamable-http";
export type Phase = "disabled" | "connecting" | "ready" | "error" | "external";

/** 配置来源：DSH 自己的 servers.json，以及只读聚合进来的外部客户端。 */
export type SourceId = "dsh" | "codebuddy";

/** `unsupported` 表示对方配置里的传输方式本插件接不了（例如 sse）。 */
export type DiscoveredTransport = Transport | "unsupported";

/** 外部来源里的一条配置，密钥值已掩码成 `***`。 */
export interface DiscoveredServer {
  name: string;
  transport: DiscoveredTransport;
  rawType?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  importable: boolean;
  /** 含 `${VAR}` 的字段名；导入后需要手动替换。 */
  placeholders: string[];
}

/** 与 src/servers.ts 的 ServerView 保持一致；客户端不 import 服务端模块，避免把 node 代码打进 bundle。 */
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
  /** 该条目来自哪个来源；`codebuddy` 的条目只读，只能导入。 */
  origin: SourceId;
  importable?: boolean;
  placeholders?: string[];
  /** 外部来源里原始的 `type`，用于说明为什么不可导入。 */
  rawType?: string;
}

/** 面板里的一级分组：一个来源 = 一个配置文件。 */
export interface SourceGroup {
  id: SourceId;
  configPath: string;
  writable: boolean;
  servers: ServerView[];
  error?: string;
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
  /** 按来源分组后的视图，面板以此渲染；上面三个字段保留给老调用方。 */
  groups: SourceGroup[];
  storeError?: string;
}

/** settings.section 组件收到的 owner props；`t` 由 apply 里的 slot inject 提供。 */
export interface SectionProps {
  t?: Translate;
}

/** Host 端 `/update` 的应答：远端最新版本与它的来源。 */
export interface UpdateInfo {
  latestVersion: string | null;
  tagName: string | null;
  source: "release" | "package" | "none";
  url: string;
  publishedAt: string | null;
}

export interface ClientContext {
  effect: (effect: () => (() => void) | void, label?: string) => unknown;
  locale: {
    register: (namespace: string, dictionary: Record<string, Record<string, string>>) => () => void;
    bind: (namespace: string) => Translate;
    getLocale?: () => { active: string };
  };
  slots: {
    inject: (name: string, factory: () => unknown) => unknown;
    register: (
      options: Record<string, unknown>,
      component: (props: SectionProps) => React.ReactElement | null,
    ) => unknown;
  };
}

interface Require {
  (id: "react"): typeof React;
  (id: string): unknown;
}

declare global {
  interface Window {
    __ModuleLoader__: {
      load: (module: { id: string; factory: (require: Require) => Record<string, unknown> }) => void;
    };
  }
}
