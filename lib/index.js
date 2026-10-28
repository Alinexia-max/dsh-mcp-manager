import { messageOf } from "./store.js";
import { createSupervisor } from "./servers.js";
const name = "mcp-manager";
const inject = ["webServer", "tools"];
const API_PREFIX = "/api/dsh-mcp-manager";
const CLIENT_MARKER_HEADER = "x-dsh-mcp-manager";
const MAX_BODY_BYTES = 64 * 1024;
function json(res, code, payload, headOnly = false) {
  if (!res || res.writableEnded || res.destroyed) return;
  res.once("error", () => void 0);
  try {
    const body = JSON.stringify(payload);
    res.writeHead(code, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store"
    });
    res.end(headOnly ? void 0 : body);
  } catch {
  }
}
function run(res, task, headOnly = false) {
  return Promise.resolve().then(task).then((result) => {
    if (result !== null && typeof result === "object" && "ok" in result && result.ok === false) {
      json(res, 400, result, headOnly);
    } else {
      json(res, 200, { ok: true, data: result }, headOnly);
    }
  }).catch((caught) => fail(res, caught, headOnly));
}
function fail(res, caught, headOnly = false) {
  const error = caught;
  json(
    res,
    Number.isInteger(error?.statusCode) ? error.statusCode : 500,
    {
      ok: false,
      ...typeof error?.code === "string" ? { code: error.code } : {},
      error: messageOf(caught)
    },
    headOnly
  );
}
function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const failWith = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        const error = new Error("body too large");
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
        const parsed = raw === "" ? {} : JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          const error = new Error("\u8BF7\u6C42\u4F53\u5FC5\u987B\u662F JSON \u5BF9\u8C61");
          error.statusCode = 400;
          error.code = "error.proto.invalidBody";
          failWith(error);
          return;
        }
        settled = true;
        resolve(parsed);
      } catch (caught) {
        const error = new Error(`invalid JSON body: ${messageOf(caught)}`);
        error.statusCode = 400;
        error.code = "error.proto.invalidJson";
        failWith(error);
      }
    });
    req.on("error", (caught) => {
      const error = caught;
      error.statusCode = error.statusCode ?? 400;
      failWith(error);
    });
  });
}
function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return void 0;
  }
}
function canonicalAuthority(authority, parsed) {
  const port = parsed.port !== "" ? parsed.port : new URL(`https://${authority}`).port;
  return port === "" ? parsed.hostname : `${parsed.hostname}:${port}`;
}
function isCanonicalAuthority(authority, parsed) {
  return canonicalAuthority(authority, parsed) === authority.toLowerCase();
}
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    if (typeof entry !== "string") return false;
    const entryUrl = parseAuthority(entry);
    if (entryUrl === void 0 || !isCanonicalAuthority(entry, entryUrl)) return false;
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
  });
}
function validateRequestOrigin(req, trustedHosts) {
  const host = typeof req.headers.host === "string" ? req.headers.host : "";
  const hostUrl = parseAuthority(host);
  const forbidden = { statusCode: 403, code: "error.proto.forbiddenHost", error: "forbidden host" };
  if (hostUrl === void 0 || !isCanonicalAuthority(host, hostUrl)) return forbidden;
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
function validateMutationRequest(req, trustedHosts) {
  const hostError = validateRequestOrigin(req, trustedHosts);
  if (hostError !== null) return hostError;
  if (req.headers[CLIENT_MARKER_HEADER] !== "1") {
    return { statusCode: 403, code: "error.proto.forbidden", error: "forbidden mutation request" };
  }
  const contentType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return { statusCode: 415, code: "error.proto.contentType", error: "content-type must be application/json" };
  }
  return null;
}
function trustedHostsOf(ctx) {
  try {
    const raw = ctx;
    const root = raw.root ?? raw;
    const candidate = root.webRuntime ?? root.webStartup;
    if (candidate !== null && typeof candidate === "object") {
      const hosts = candidate.trustedHosts;
      if (Array.isArray(hosts)) return hosts.filter((item) => typeof item === "string");
    }
  } catch {
  }
  return [];
}
function methodNotAllowed(res, method) {
  json(res, 405, {
    ok: false,
    code: "error.proto.method",
    error: `method not allowed: ${method ?? "unknown"}`
  });
}
function notFound(res, path) {
  json(res, 404, { ok: false, code: "error.proto.unknownAction", error: `unknown action: ${path}` });
}
function apply(ctx, config) {
  const log = (message) => {
    try {
      ctx.logger?.warn?.(message);
    } catch {
    }
  };
  const supervisor = createSupervisor({
    ctx,
    autostart: config?.autostart !== false,
    log
  });
  ctx.effect(
    () => () => {
      void supervisor.dispose();
    },
    "mcp-manager: dispose mcp servers"
  );
  ctx.effect(
    () => ctx.webServer.register({
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
          const segments = path.slice(API_PREFIX.length).split("/").filter((segment) => segment !== "");
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
      }
    }),
    "mcp-manager: API route"
  );
}
export {
  apply,
  inject,
  name
};
