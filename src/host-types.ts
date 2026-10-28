import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * 宿主服务的最小契约。
 *
 * 为什么全部手写：插件对宿主只作 peer 依赖，静态 import `@deepseek-ai/*` 会把插件
 * 绑死在某一个小版本上；鸭子类型让它在多个宿主版本里都能加载。
 */

/** Cordis fiber 的最小可用面：dispose 卸载，then 表示“加载完成”。 */
export interface PluginFiber {
  dispose?: () => void | Promise<void>;
  then?: unknown;
}

/** `ctx.tools.schemas()` 的返回项；只保留面板展示需要的字段。 */
export interface ToolSchema {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface ToolsService {
  schemas?: (scope?: unknown) => ToolSchema[];
}

/** profile 事实（只读）；非 profile 模式下不存在。 */
export interface ProfileFacts {
  name?: string;
  dir?: string;
  home?: string;
  patchPath?: string;
}

export interface HostLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface HostContext {
  root?: unknown;
  logger?: HostLogger;
  effect: (effect: () => (() => void) | void, label?: string) => unknown;
  webServer: {
    register: (route: {
      kind: string;
      path: string;
      handler: (req: IncomingMessage, res: ServerResponse) => unknown;
    }) => () => void;
  };
  tools?: ToolsService;
  profileContext?: ProfileFacts;
  /** Cordis 运行时挂载入口；动态挂载 MCP 客户端依赖它。 */
  plugin?: (plugin: unknown, config?: unknown) => PluginFiber;
  get?: (key: string) => unknown;
}
