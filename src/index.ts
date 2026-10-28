import type { IncomingMessage, ServerResponse } from "node:http";

import type { CodedError } from "./store.js";
import { messageOf } from "./store.js";
import { createSupervisor } from "./servers.js";
import type { HostContext } from "./host-types.js";

/** Cordis 插件的诊断名；与 package.json 的 row id 保持一致便于排查。 */
const name = "mcp-manager";
/** `webServer` 提供 HTTP 路由，`tools` 用于枚举 mcp__<server>__<tool> 反推状态。 */
const inject = ["webServer", "tools"];

const API_PREFIX = "/api/dsh-mcp-manager";
const CLIENT_MARKER_HEADER = "x-dsh-mcp-manager";
const MAX_BODY_BYTES = 64 * 1024;

export interface PluginConfig {
  /** false 时不自动重连已启用的服务器（面板与路由仍然可用）。 */
  autostart?: boolean;
}

interface OriginError {
  statusCode: number;
  code: string;
  error: string;
}

function json(res: ServerResponse, code: number, payload: unknown, headOnly = false): void {
  if (!res || res.writableEnded || res.destroyed) return;
  res.once("error", () => undefined);
  try {
    const body = JSON.stringify(payload);
    res.writeHead(code, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    // HEAD 返回与实体一致的 content-length，但不输出 body。
    res.end(headOnly ? undefined : body);
  } catch {
    // 客户端已断开。
  }
}

/** 成功统一包成 `{ ok: true, data }`；核心返回 `{ ok:false, error }` 时透传为 400。 */
function run(res: ServerResponse, task: () => unknown, headOnly = false): Promise<void> {
  return Promise.resolve()
    .then(task)
    .then((result) => {
      if (result !== null && typeof result === "object" && "ok" in result && (result as { ok?: unknown }).ok === false) {
        json(res, 400, result, headOnly);
      } else {
        json(res, 200, { ok: true, data: result }, headOnly);
      }
    })
    .catch((caught: unknown) => fail(res, caught, headOnly));
}

function fail(res: ServerResponse, caught: unknown, headOnly = false): void {
  const error = caught as CodedError;
  json(
    res,
    Number.isInteger(error?.statusCode) ? (error.statusCode as number) : 500,
    {
      ok: false,
      ...(typeof error?.code === "string" ? { code: error.code } : {}),
      error: messageOf(caught),
    },
    headOnly,
  );
}

function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    const failWith = (error: CodedError) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        const error = new Error("body too large") as CodedError;
        error.statusCode = 413;
        error.code = "error.proto.bodyTooLarge";
        failWith(error);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        const parsed: unknown = raw === "" ? {} : JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          const error = new Error("请求体必须是 JSON 对象") as CodedError;
          error.statusCode = 400;
          error.code = "error.proto.invalidBody";
          failWith(error);
          return;
        }
        settled = true;
        resolve(parsed as Record<string, unknown>);
      } catch (caught) {
        const error = new Error(`invalid JSON body: ${messageOf(caught)}`) as CodedError;
        error.statusCode = 400;
        error.code = "error.proto.invalidJson";
        failWith(error);
      }
    });
    req.on("error", (caught: Error) => {
      const error = caught as CodedError;
      error.statusCode = error.statusCode ?? 400;
      failWith(error);
    });
  });
}

/** 将裸 `host[:port]` 解析为 URL；非法形态返回 undefined。 */
function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return undefined;
  }
}

/** 用 http/https 双重解析保留显式的 :80 / :443，避免默认端口被剥离后扩大授权范围。 */
function canonicalAuthority(authority: string, parsed: URL): string {
  const port = parsed.port !== "" ? parsed.port : new URL(`https://${authority}`).port;
  return port === "" ? parsed.hostname : `${parsed.hostname}:${port}`;
}

function isCanonicalAuthority(authority: string, parsed: URL): boolean {
  return canonicalAuthority(authority, parsed) === authority.toLowerCase();
}

/** 与 DSH `/api` 信任栅栏一致：localhost、IPv6 loopback 或 IPv4 127/8。 */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/** 带端口的 trustedHosts 条目精确匹配；不带端口的条目匹配同主机的任意端口。 */
function isTrustedAuthority(hostUrl: URL, trustedHosts: string[]): boolean {
  return trustedHosts.some((entry) => {
    if (typeof entry !== "string") return false;
    const entryUrl = parseAuthority(entry);
    if (entryUrl === undefined || !isCanonicalAuthority(entry, entryUrl)) return false;
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host;
  });
}

/** 未知 Host、跨站 Fetch 或异源 Origin 一律拒绝，避免被任意网页驱动去连恶意服务器。 */
function validateRequestOrigin(req: IncomingMessage, trustedHosts: string[]): OriginError | null {
  const host = typeof req.headers.host === "string" ? req.headers.host : "";
  const hostUrl = parseAuthority(host);
  const forbidden: OriginError = { statusCode: 403, code: "error.proto.forbiddenHost", error: "forbidden host" };
  if (hostUrl === undefined || !isCanonicalAuthority(host, hostUrl)) return forbidden;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return forbidden;
  if (req.headers["sec-fetch-site"] === "cross-site") return forbidden;
  const origin = req.headers.origin;
  if (typeof origin === "string") {
    try {
      if (new URL(origin).host !== hostUrl.host) return forbidden;
    } catch {
      return forbidden;
    }
  }
  return null;
}

/** 写接口额外要求自定义头与 JSON：自定义头迫使跨站 fetch 走预检，而本路由不回 CORS。 */
function validateMutationRequest(req: IncomingMessage, trustedHosts: string[]): OriginError | null {
  const hostError = validateRequestOrigin(req, trustedHosts);
  if (hostError !== null) return hostError;
  if (req.headers[CLIENT_MARKER_HEADER] !== "1") {
    return { statusCode: 403, code: "error.proto.forbidden", error: "forbidden mutation request" };
  }
  const contentType = String(req.headers["content-type"] ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return { statusCode: 415, code: "error.proto.contentType", error: "content-type must be application/json" };
  }
  return null;
}

/** 从 `root.webRuntime` / `root.webStartup` 里尽量取到 LAN 信任列表，取不到就只信 loopback。 */
function trustedHostsOf(ctx: HostContext): string[] {
  try {
    const raw = ctx as unknown as Record<string, unknown>;
    const root = (raw.root ?? raw) as Record<string, unknown>;
    const candidate = root.webRuntime ?? root.webStartup;
    if (candidate !== null && typeof candidate === "object") {
      const hosts = (candidate as { trustedHosts?: unknown }).trustedHosts;
      if (Array.isArray(hosts)) return hosts.filter((item): item is string => typeof item === "string");
    }
  } catch {
    // 宿主结构随版本变化，失败时降级到 loopback。
  }
  return [];
}

function methodNotAllowed(res: ServerResponse, method: string | undefined): void {
  json(res, 405, {
    ok: false,
    code: "error.proto.method",
    error: `method not allowed: ${method ?? "unknown"}`,
  });
}

function notFound(res: ServerResponse, path: string): void {
  json(res, 404, { ok: false, code: "error.proto.unknownAction", error: `unknown action: ${path}` });
}

function apply(ctx: HostContext, config?: PluginConfig): void {
  const log = (message: string) => {
    try {
      ctx.logger?.warn?.(message);
    } catch {
      // 日志失败不影响功能。
    }
  };

  const supervisor = createSupervisor({
    ctx,
    autostart: config?.autostart !== false,
    log,
  });

  // Cordis 不会收集 apply 返回的 disposer，必须用 ctx.effect 显式托管生命周期。
  ctx.effect(
    () => () => {
      void supervisor.dispose();
    },
    "mcp-manager: dispose mcp servers",
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: API_PREFIX,
        handler: async (req, res) => {
          const url = new URL(req.url ?? "/", "http://localhost");
          const path = url.pathname.replace(/\/+$/, "");
          const trustedHosts = trustedHostsOf(ctx);
          try {
            const hostError = validateRequestOrigin(req, trustedHosts);
            if (hostError !== null) {
              json(res, hostError.statusCode, { ok: false, code: hostError.code, error: hostError.error });
              return;
            }
            if (path !== API_PREFIX && !path.startsWith(`${API_PREFIX}/`)) {
              notFound(res, path);
              return;
            }
            const segments = path
              .slice(API_PREFIX.length)
              .split("/")
              .filter((segment) => segment !== "");

            if (req.method === "GET" || req.method === "HEAD") {
              const headOnly = req.method === "HEAD";
              if (segments.length === 0) return run(res, () => supervisor.state(), headOnly);
              if (segments[0] !== "servers") {
                notFound(res, path);
                return;
              }
              if (segments.length === 1) return run(res, () => supervisor.list(), headOnly);
              if (segments.length === 3 && segments[2] === "tools") {
                return run(res, () => supervisor.tools(segments[1]), headOnly);
              }
              notFound(res, path);
              return;
            }

            if (req.method !== "POST") {
              methodNotAllowed(res, req.method);
              return;
            }

            const requestError = validateMutationRequest(req, trustedHosts);
            if (requestError !== null) {
              json(res, requestError.statusCode, { ok: false, code: requestError.code, error: requestError.error });
              return;
            }

            const body = await readBody(req);

            // 只读来源的条目不能就地编辑，只能复制成本地服务器。
            if (segments.length === 1 && segments[0] === "import") {
              return run(res, () => supervisor.importServer(body));
            }

            if (segments[0] !== "servers") {
              notFound(res, path);
              return;
            }
            if (segments.length === 1) return run(res, () => supervisor.create(body));

            const id = segments[1];
            const action = segments[2];
            if (segments.length !== 3) {
              notFound(res, path);
              return;
            }
            switch (action) {
              case "update":
                return run(res, () => supervisor.update(id, body));
              case "delete":
                return run(res, () => supervisor.remove(id).then(() => null));
              case "enable":
                return run(res, () => supervisor.setEnabled(id, true));
              case "disable":
                return run(res, () => supervisor.setEnabled(id, false));
              case "reconnect":
                return run(res, () => supervisor.reconnect(id));
              default:
                notFound(res, path);
            }
          } catch (caught) {
            fail(res, caught);
          }
        },
      }),
    "mcp-manager: API route",
  );
}

export { apply, inject, name };
