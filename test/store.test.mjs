// 存储层契约：校验、密钥打码/沿用、原子写、损坏文件拒绝覆盖。
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

/** 断言某次调用抛出带指定 code 的错误。 */
async function rejects(fn, code, message) {
  try {
    await fn();
    ok(false, message);
  } catch (caught) {
    ok(caught?.code === code, `${message} (got code ${JSON.stringify(caught?.code)})`);
  }
}

const home = await mkdtemp(join(tmpdir(), "dsh-mcp-manager-store-"));
process.env.DSH_HOME = home;

const store = await import(new URL("../lib/store.js", import.meta.url).href);

eq(store.storePath(), join(home, "mcp-manager", "servers.json"), "store path lives under DSH_HOME");

eq(await store.readStore(), { version: 1, servers: [] }, "missing file reads as an empty store");

const stdioInput = store.parseInput({
  serverName: "demo",
  transport: "stdio",
  command: " npx ",
  args: ["-y", "@modelcontextprotocol/server-everything"],
  env: { TOKEN: "abc" },
});
eq(stdioInput.command, "npx", "command is trimmed");
eq(stdioInput.args, ["-y", "@modelcontextprotocol/server-everything"], "args are preserved");
eq(stdioInput.enabled, true, "enabled defaults to true");

await rejects(
  () => Promise.resolve().then(() => store.parseInput({ serverName: "bad name!", transport: "stdio", command: "x" })),
  "error.input.serverName",
  "invalid server name is rejected",
);
await rejects(
  () => Promise.resolve().then(() => store.parseInput({ serverName: "demo", transport: "stdio" })),
  "error.input.command",
  "stdio without a command is rejected",
);
await rejects(
  () =>
    Promise.resolve().then(() =>
      store.parseInput({ serverName: "demo", transport: "streamable-http", url: "ftp://example.com" }),
    ),
  "error.input.url",
  "non-http url is rejected",
);
await rejects(
  () =>
    Promise.resolve().then(() =>
      store.parseInput({ serverName: "demo", transport: "stdio", command: "x", toolCallTimeoutMs: 1 }),
    ),
  "error.input.timeout",
  "out-of-range timeout is rejected",
);

const httpInput = store.parseInput({
  serverName: "remote",
  transport: "streamable-http",
  url: "https://example.com/mcp",
  headers: { Authorization: "Bearer secret" },
});
eq(httpInput.url, "https://example.com/mcp", "http url is normalized");
eq(httpInput.transport, "streamable-http", "transport is kept");

const record = store.applyInput(stdioInput);
ok(typeof record.id === "string" && record.id.length > 0, "record gets an id");
eq(record.createdAt, record.updatedAt, "create stamps both timestamps");

const masked = store.maskRecord(record);
eq(masked.env, { TOKEN: "***" }, "secrets are masked on the way out");
eq(record.env, { TOKEN: "abc" }, "masking does not mutate the stored record");

const updated = store.applyInput(
  store.parseInput({ serverName: "demo", transport: "stdio", command: "node", env: { TOKEN: "***" } }),
  record,
);
eq(updated.env, { TOKEN: "abc" }, "*** keeps the previous secret");
eq(updated.id, record.id, "update keeps the id");
eq(updated.command, "node", "update applies the new command");

const dropped = store.applyInput(
  store.parseInput({ serverName: "demo", transport: "stdio", command: "node", env: {} }),
  record,
);
eq(dropped.env, {}, "dropping a key really removes it");

await store.writeStore({ version: 1, servers: [record] });
const reloaded = await store.readStore();
eq(reloaded.servers.length, 1, "store round-trips");
eq(reloaded.servers[0].env, { TOKEN: "abc" }, "secrets persist in plain text on disk");

const onDisk = JSON.parse(await readFile(store.storePath(), "utf8"));
eq(onDisk.version, 1, "file carries the schema version");

await writeFile(store.storePath(), "{ not json", "utf8");
await rejects(() => store.readStore(), "error.store.corrupt", "corrupt JSON is refused instead of overwritten");

const config = store.toMcpConfig(record);
eq(config.transport, "stdio", "mcp config keeps the transport");
eq(config.failOnStartupError, true, "startup failures must be visible in the panel");
eq(config.args.length, 2, "mcp config carries args");

console.log(`\nstore: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
