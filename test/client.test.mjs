// 客户端产物契约：能被宿主的 AMD loader 捕获、factory 可执行、apply 挂对槽位、
// 表单/校验/基址解析的纯函数行为正确。
import react from "react";
import * as reactDom from "react-dom";
import * as reactDomClient from "react-dom/client";
import { readFile } from "node:fs/promises";

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

const bundleSource = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");

// 模拟宿主加载器：执行 bundle 拿到 load 定义，再用冻结模块表调用 factory。
let loaded = null;
new Function("window", bundleSource)({
  __ModuleLoader__: {
    load(definition) {
      loaded = definition;
    },
  },
});

ok(loaded !== null && typeof loaded.factory === "function", "bundle registers through __ModuleLoader__.load");
eq(loaded?.id, "@local/dsh-mcp-manager", "bundle id matches the package name");

const fakePrimitives = {
  Button: (props) => react.createElement("button", props, props.children),
  Input: (props) => react.createElement("input", props),
  Modal: (props) => (props.open ? react.createElement("div", props, props.children) : null),
};

const bundle = loaded.factory((id) => {
  if (id === "react") return react;
  if (id === "react/jsx-runtime") {
    return { jsx: react.createElement, jsxs: react.createElement, Fragment: react.Fragment };
  }
  if (id === "react-dom") return reactDom;
  if (id === "react-dom/client") return reactDomClient;
  if (id === "@deepseek-ai/dsh-client-ui-primitives") return fakePrimitives;
  throw new Error(`unexpected require: ${id}`);
});

eq(bundle.inject, ["slots", "locale"], "client declares its host dependencies");
ok(typeof bundle.apply === "function", "factory exports apply");
eq(bundle.DICT.zh.title, "MCP 服务器", "zh dictionary carries the section title");
eq(bundle.DICT.en.title, "MCP Servers", "en dictionary carries the section title");
eq(Object.keys(bundle.DICT.zh).length, Object.keys(bundle.DICT.en).length, "both dictionaries have the same keys");

eq(bundle.parsePairs("A=1\nB = 2\n\nbroken"), { A: "1", B: "2" }, "pairs parse ignores blank and malformed lines");

const blank = bundle.draftFrom(null);
eq(blank.transport, "stdio", "new drafts default to stdio");
eq(blank.enabled, true, "new drafts default to enabled");

const filled = bundle.draftFrom({
  id: "abc",
  serverName: "remote",
  transport: "streamable-http",
  enabled: false,
  toolCount: 0,
  url: "https://example.com/mcp",
  headers: { Authorization: "***" },
  createdAt: "",
  updatedAt: "",
  external: false,
});
eq(filled.transport, "streamable-http", "draft keeps the transport");
eq(filled.headers, "Authorization=***", "draft renders headers one per line");
eq(filled.enabled, false, "draft keeps the enabled flag");

eq(bundle.validate(blank, bundle.DICT.zh ? (key) => bundle.DICT.zh[key] : String), "请填写服务器名称", "empty name is rejected");

const validDraft = Object.assign({}, blank, { serverName: "demo", command: "npx", args: "-y\npkg" });
eq(bundle.validate(validDraft, (key) => bundle.DICT.zh[key]), null, "a filled stdio draft is valid");

const invalidTimeout = Object.assign({}, validDraft, { toolCallTimeoutMs: "10" });
eq(
  bundle.validate(invalidTimeout, (key) => bundle.DICT.zh[key]),
  bundle.DICT.zh["error.timeout"],
  "out-of-range timeout is rejected client-side",
);

const payload = bundle.payloadFrom(Object.assign({}, validDraft, { env: "TOKEN=abc" }));
eq(payload.args, ["-y", "pkg"], "args are split one per line");
eq(payload.env, { TOKEN: "abc" }, "env is parsed into an object");
eq(payload.enabled, true, "payload carries the enabled flag");
ok(!("url" in payload), "stdio payload has no url");

const httpPayload = bundle.payloadFrom(
  Object.assign({}, blank, { serverName: "remote", transport: "streamable-http", url: "https://example.com/mcp" }),
);
eq(httpPayload.url, "https://example.com/mcp", "http payload carries the url");
ok(!("command" in httpPayload), "http payload has no command");

/** 在指定页面基址下解析一次，用完恢复，避免污染其它断言。 */
function withBase(baseURI, run) {
  const previous = Object.prototype.hasOwnProperty.call(globalThis, "document") ? globalThis.document : undefined;
  globalThis.document = baseURI === undefined ? undefined : { baseURI };
  try {
    return run();
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}

withBase("https://nas.example.com/app/dsh/", () => {
  eq(
    bundle.resolveApiUrl("/api/dsh-mcp-manager/servers"),
    "https://nas.example.com/app/dsh/api/dsh-mcp-manager/servers",
    "reverse-proxy prefix is preserved",
  );
});
withBase("https://host.example.com/", () => {
  eq(bundle.resolveApiUrl("/api/x"), "https://host.example.com/api/x", "root deployment resolves to the root");
});
withBase(undefined, () => {
  eq(bundle.resolveApiUrl("/api/x"), "/api/x", "no document keeps the path untouched");
});

// 分组面板的检索/过滤是纯前端逻辑，直接对纯函数断言。
const filterSamples = [
  { id: "a", serverName: "context7", origin: "dsh", phase: "ready", command: "npx", args: ["-y", "pkg"] },
  { id: "b", serverName: "github", origin: "codebuddy", phase: "external", url: "https://api.githubcopilot.com/mcp/" },
  { id: "c", serverName: "legacy", origin: "codebuddy", phase: "external", url: "https://example.com/sse" },
];
eq(
  bundle.filterServers(filterSamples, { keyword: "", source: "all", phase: "all" }).length,
  3,
  "an empty filter keeps every server",
);
eq(
  bundle.filterServers(filterSamples, { keyword: "github", source: "all", phase: "all" }).map((item) => item.id),
  ["b"],
  "keyword matches the server name",
);
eq(
  bundle.filterServers(filterSamples, { keyword: "API.GITHUB", source: "all", phase: "all" }).map((item) => item.id),
  ["b"],
  "keyword is case-insensitive and also covers the url",
);
eq(
  bundle.filterServers(filterSamples, { keyword: "", source: "codebuddy", phase: "all" }).map((item) => item.id),
  ["b", "c"],
  "source filter keeps only that source",
);
eq(
  bundle.filterServers(filterSamples, { keyword: "", source: "all", phase: "ready" }).map((item) => item.id),
  ["a"],
  "phase filter keeps only that phase",
);

// 检查更新只在本地比版本号，比较规则要能处理 v 前缀、多位段与预发布。
eq(bundle.compareVersions("1.0.1", "1.0.0"), 1, "patch bump is newer");
eq(bundle.compareVersions("1.0.0", "1.0.1"), -1, "older patch is detected");
eq(bundle.compareVersions("v1.0.0", "1.0.0"), 0, "v prefix is ignored");
eq(bundle.compareVersions("1.10.0", "1.9.9"), 1, "numeric segments compare numerically");
eq(bundle.compareVersions("1.0.0", "1.0.0-rc.1"), 1, "release outranks its prerelease");
eq(bundle.compareVersions("2.0", "2.0.0"), 0, "missing segments count as zero");

const effects = [];
const registered = [];
const localeRegistrations = [];
const slots = {
  inject(name, factory) {
    registered.push(name);
    factory();
  },
  register(options, component) {
    registered.push(options);
    ok(typeof component === "function", "slot component is a function");
    return () => undefined;
  },
};
const clientCtx = {
  effect(effect) {
    effects.push(effect);
    const dispose = effect();
    if (typeof dispose === "function") effects.push(dispose);
  },
  locale: {
    register(namespace, dictionary) {
      localeRegistrations.push({ namespace, dictionary });
      return () => undefined;
    },
    bind() {
      return (key) => bundle.DICT.zh[key] ?? key;
    },
  },
  slots,
};

bundle.apply(clientCtx);
eq(registered[0], "settings.section", "apply injects the settings.section slot");
eq(registered[1].name, "settings.section", "slot registration targets settings.section");
eq(registered[1].id, "mcp-manager", "slot id matches the plugin");
eq(localeRegistrations[0].namespace, "mcp-manager", "locale namespace matches the plugin");
ok(Object.keys(localeRegistrations[0].dictionary).length === 2, "locale registers zh and en");

console.log(`\nclient: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
