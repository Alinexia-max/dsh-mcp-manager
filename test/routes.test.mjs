// 路由契约：安全栅栏、CRUD、密钥沿用、错误码、只读来源导入。用假 ctx + 假 req/res 跑真实产物。
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;

function ok(condition, message) {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error("✗ " + message);
  }
}

function eq(actual, expected, message) {
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`,
  );
}

const home = await mkdtemp(join(tmpdir(), "dsh-mcp-manager-routes-"));
process.env.DSH_HOME = home;

// CodeBuddy 侧用环境变量指向临时文件，避免测试依赖开发者本机的 ~/.codebuddy。
const codebuddyFile = join(home, "codebuddy-mcp.json");
process.env.DSMM_CODEBUDDY_MCP = codebuddyFile;
await writeFile(
  codebuddyFile,
  JSON.stringify(
    {
      mcpServers: {
        context7: {
          command: "npx",
          args: ["-y", "@upstash/context7-mcp"],
          env: { API_KEY: "secret-value" },
        },
        legacy: { type: "sse", url: "https://example.com/sse" },
        github: {
          type: "http",
          url: "https://api.githubcopilot.com/mcp/",
          headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
        },
      },
    },
    null,
    2,
  ),
  "utf8",
);

const plugin = await import(new URL("../lib/index.js", import.meta.url).href);

const routes = [];
const disposers = [];
const ctx = {
  webServer: {
    register(route) {
      routes.push(route);
      return () => undefined;
    },
  },
  effect(effect) {
    const dispose = effect();
    if (typeof dispose === "function") disposers.push(dispose);
  },
  tools: { schemas: () => [] },
  logger: { warn() {} },
};

plugin.apply(ctx, { autostart: false });

eq(plugin.name, "mcp-manager", "plugin name matches the patch row");
eq(plugin.inject, ["webServer", "tools"], "plugin declares its host dependencies");
eq(routes.length, 1, "apply registers exactly one API route");
eq(routes[0].kind, "prefix", "route is a prefix route");
eq(routes[0].path, "/api/dsh-mcp-manager", "route lives under the plugin prefix");
eq(disposers.length, 2, "server lifetime and route lifetime are both owned by ctx.effect");
ok(
  disposers.every((dispose) => typeof dispose === "function"),
  "ctx.effect disposers are callable",
);

const route = routes[0];
const BASE = "http://127.0.0.1:3123";
const HOST_HEADER = "127.0.0.1:3123";

function makeRequest(options) {
  const listeners = {};
  const req = {
    method: options.method ?? "GET",
    url: options.url,
    headers: Object.assign({ host: HOST_HEADER }, options.headers ?? {}),
    on(event, callback) {
      (listeners[event] ??= []).push(callback);
      return req;
    },
    resume() {},
  };
  const body = options.body;
  setTimeout(() => {
    if (body !== undefined) {
      const raw = typeof body === "string" ? body : JSON.stringify(body);
      for (const callback of listeners.data ?? []) callback(Buffer.from(raw));
    }
    for (const callback of listeners.end ?? []) callback();
  }, 0);
  return req;
}

function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writableEnded: false,
    destroyed: false,
    once() {},
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers ?? {};
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
      this.writableEnded = true;
    },
  };
}

async function call(method, path, options = {}) {
  const request = makeRequest({
    method,
    url: BASE + path,
    headers: options.headers,
    body: options.body,
  });
  const response = makeResponse();
  await route.handler(request, response);
  let payload;
  try {
    payload = JSON.parse(response.body);
  } catch {
    payload = undefined;
  }
  return { status: response.statusCode, payload, headers: response.headers };
}

const MUTATION_HEADERS = { "content-type": "application/json", "x-dsh-mcp-manager": "1" };

const state = await call("GET", "/api/dsh-mcp-manager");
eq(state.status, 200, "GET without segments returns the state");
eq(state.payload?.ok, true, "state response is a success envelope");
ok(String(state.payload?.data?.storePath).endsWith("servers.json"), "state exposes the config path");
eq(state.headers["cache-control"], "no-store", "API responses are not cacheable");

const groups = state.payload?.data?.groups ?? [];
eq(groups.length, 2, "state groups servers by source");
eq(groups[0]?.id, "dsh", "the first group is the DSH store");
eq(groups[0]?.writable, true, "the DSH group is writable");
eq(groups[0]?.configPath, join(home, "mcp-manager", "servers.json"), "the DSH group exposes its config path");
eq(groups[1]?.id, "codebuddy", "the second group is the CodeBuddy source");
eq(groups[1]?.writable, false, "the CodeBuddy group is read-only");
eq(groups[1]?.configPath, codebuddyFile, "the CodeBuddy group exposes its config path");
eq(groups[1]?.servers.length, 3, "every CodeBuddy entry is listed");

const context7 = groups[1]?.servers.find((item) => item.serverName === "context7");
eq(context7?.env, { API_KEY: "***" }, "CodeBuddy secrets never leave the host in clear text");
eq(context7?.origin, "codebuddy", "discovered entries carry their source");
eq(context7?.importable, true, "stdio entries are importable");

const legacy = groups[1]?.servers.find((item) => item.serverName === "legacy");
eq(legacy?.importable, false, "sse entries are listed but not importable");
eq(legacy?.rawType, "sse", "the original type is reported for unsupported transports");

const githubEntry = groups[1]?.servers.find((item) => item.serverName === "github");
eq(githubEntry?.transport, "streamable-http", "http entries map to streamable-http");
ok(
  githubEntry?.placeholders.includes("headers.Authorization"),
  "placeholders are reported so the UI can warn about manual replacement",
);

const rejected = await call("POST", "/api/dsh-mcp-manager/servers", {
  headers: { "content-type": "application/json" },
  body: { serverName: "demo", transport: "stdio", command: "npx" },
});
eq(rejected.status, 403, "mutation without the marker header is forbidden");

const forbiddenHost = await call("GET", "/api/dsh-mcp-manager", {
  headers: { host: "evil.example.com" },
});
eq(forbiddenHost.status, 403, "unknown host is forbidden");

const wrongType = await call("POST", "/api/dsh-mcp-manager/servers", {
  headers: { "content-type": "text/plain", "x-dsh-mcp-manager": "1" },
  body: "{}",
});
eq(wrongType.status, 415, "mutations must be JSON");

const badName = await call("POST", "/api/dsh-mcp-manager/servers", {
  headers: MUTATION_HEADERS,
  body: { serverName: "bad name", transport: "stdio", command: "npx" },
});
eq(badName.status, 400, "invalid server name is rejected");
eq(badName.payload?.code, "error.input.serverName", "invalid name keeps its error code");

const created = await call("POST", "/api/dsh-mcp-manager/servers", {
  headers: MUTATION_HEADERS,
  body: {
    serverName: "demo",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everything"],
    env: { TOKEN: "abc" },
    enabled: false,
  },
});
eq(created.status, 200, "create succeeds");
const server = created.payload?.data;
eq(server?.serverName, "demo", "created server keeps its name");
eq(server?.transport, "stdio", "created server keeps its transport");
eq(server?.phase, "disabled", "disabled server reports disabled");
eq(server?.env, { TOKEN: "***" }, "create response masks secrets");
ok(typeof server?.id === "string" && server.id.length > 0, "create returns an id");

const duplicate = await call("POST", "/api/dsh-mcp-manager/servers", {
  headers: MUTATION_HEADERS,
  body: { serverName: "demo", transport: "stdio", command: "npx", enabled: false },
});
eq(duplicate.status, 409, "duplicate server name is rejected");
eq(duplicate.payload?.code, "error.server.duplicate", "duplicate keeps its error code");

const listed = await call("GET", "/api/dsh-mcp-manager/servers");
eq(listed.status, 200, "list succeeds");
eq(listed.payload?.data?.length, 1, "list returns the created server");

const updated = await call("POST", `/api/dsh-mcp-manager/servers/${server.id}/update`, {
  headers: MUTATION_HEADERS,
  body: {
    serverName: "demo",
    transport: "stdio",
    command: "node",
    env: { TOKEN: "***", EXTRA: "1" },
    enabled: false,
  },
});
eq(updated.status, 200, "update succeeds");
eq(updated.payload?.data?.command, "node", "update applies the new command");

const persisted = JSON.parse(await readFile(join(home, "mcp-manager", "servers.json"), "utf8"));
eq(persisted.servers[0].env, { TOKEN: "abc", EXTRA: "1" }, "*** keeps the stored secret, new keys are added");

const enabled = await call("POST", `/api/dsh-mcp-manager/servers/${server.id}/enable`, {
  headers: MUTATION_HEADERS,
  body: {},
});
eq(enabled.status, 200, "enable succeeds");
// 测试环境没有 mcp-client，也没有 ctx.plugin：失败必须变成可见的 error 状态，而不是静默成功。
eq(enabled.payload?.data?.phase, "error", "mount failure surfaces as an error phase");
ok(
  String(enabled.payload?.data?.error ?? "").length > 0,
  "mount failure carries a diagnostic message",
);

const tools = await call("GET", `/api/dsh-mcp-manager/servers/${server.id}/tools`);
eq(tools.status, 200, "tools query succeeds");
eq(tools.payload?.data, [], "no tools registered yet");

const unknown = await call("GET", "/api/dsh-mcp-manager/nope");
eq(unknown.status, 404, "unknown action returns 404");

const malformed = await call("POST", "/api/dsh-mcp-manager/servers", {
  headers: MUTATION_HEADERS,
  body: "{ not json",
});
eq(malformed.status, 400, "malformed JSON is rejected");
eq(malformed.payload?.code, "error.proto.invalidJson", "malformed JSON keeps its error code");

const wrongMethod = await call("PUT", "/api/dsh-mcp-manager/servers");
eq(wrongMethod.status, 405, "unsupported methods are rejected");

const removed = await call("POST", `/api/dsh-mcp-manager/servers/${server.id}/delete`, {
  headers: MUTATION_HEADERS,
  body: {},
});
eq(removed.status, 200, "delete succeeds");
eq((await call("GET", "/api/dsh-mcp-manager/servers")).payload?.data, [], "delete removes the entry");

const imported = await call("POST", "/api/dsh-mcp-manager/import", {
  headers: MUTATION_HEADERS,
  body: { source: "codebuddy", name: "context7" },
});
eq(imported.status, 200, "import copies a read-only entry into the local store");
eq(imported.payload?.data?.serverName, "context7", "imported entry keeps the source name");
eq(imported.payload?.data?.origin, "dsh", "imported entry is owned by DSH");
eq(imported.payload?.data?.env, { API_KEY: "***" }, "the response still masks the secret");

const persistedImport = JSON.parse(await readFile(join(home, "mcp-manager", "servers.json"), "utf8"));
eq(
  persistedImport.servers[0]?.env,
  { API_KEY: "secret-value" },
  "import reads the real secret on the host side, not from the browser",
);

const duplicateImport = await call("POST", "/api/dsh-mcp-manager/import", {
  headers: MUTATION_HEADERS,
  body: { source: "codebuddy", name: "context7" },
});
eq(duplicateImport.status, 409, "importing the same name twice is rejected");

const unsupportedImport = await call("POST", "/api/dsh-mcp-manager/import", {
  headers: MUTATION_HEADERS,
  body: { source: "codebuddy", name: "legacy" },
});
eq(unsupportedImport.status, 400, "unsupported transports cannot be imported");

const unknownImport = await call("POST", "/api/dsh-mcp-manager/import", {
  headers: MUTATION_HEADERS,
  body: { source: "cursor", name: "context7" },
});
eq(unknownImport.status, 400, "unknown sources are rejected");

for (const dispose of disposers) await dispose();

console.log(`\nroutes: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
