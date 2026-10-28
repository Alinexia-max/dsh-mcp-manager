// 产物契约：源码必须在、产物必须在、sourcemap 不许有、客户端 bundle 必须是宿主认的形态。
import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";

let passed = 0;
let failed = 0;

async function ok(condition, message) {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error("✗ " + message);
  }
}

for (const path of ["../src/index.ts", "../src/servers.ts", "../src/store.ts", "../src/client.ts"]) {
  try {
    await access(new URL(path, import.meta.url), constants.R_OK);
    await ok(true, `${path} exists as maintained source`);
  } catch {
    await ok(false, `${path} exists as maintained source`);
  }
}

for (const path of ["../lib/index.js", "../lib/servers.js", "../lib/store.js", "../lib/client.js"]) {
  try {
    await access(new URL(path, import.meta.url), constants.R_OK);
    await ok(true, `${path} exists as generated output`);
  } catch {
    await ok(false, `${path} exists as generated output`);
  }
}

for (const path of ["../lib/index.js.map", "../lib/client.js.map"]) {
  try {
    await access(new URL(path, import.meta.url), constants.F_OK);
    await ok(false, `${path} is excluded from generated output`);
  } catch {
    await ok(true, `${path} is excluded from generated output`);
  }
}

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
await ok(manifest.type === "module", "package is ESM");
await ok(manifest.main === "lib/index.js", "main points at the host entry");
await ok(manifest.exports?.["./client"] === "./lib/client.js", "exports ./client points at the client entry");
await ok(manifest.dsh?.bundle?.patch === "./cordis.patch.yml", "dsh.bundle.patch is declared");
await ok(manifest.dsh?.client?.platform === "web", "dsh.client.platform is web");
const clientInject = manifest.dsh?.client?.inject ?? [];
for (const dependency of [
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-ui-primitives",
]) {
  await ok(clientInject.includes(dependency), `dsh.client.inject declares ${dependency}`);
}
await ok(Array.isArray(manifest.files) && manifest.files.includes("lib"), "lib is published");
await ok(typeof manifest.scripts?.build === "string", "package defines a build command");
await ok(manifest.scripts?.test?.includes("build-test.mjs"), "test enforces the source-layout contract");

const typeConfig = JSON.parse(
  (await readFile(new URL("../tsconfig.json", import.meta.url), "utf8")).replace(/^\uFEFF/, ""),
);
await ok(typeConfig.compilerOptions?.strict === true, "strict type checking is on");
await ok(typeConfig.compilerOptions?.noEmit === true, "transpilation does not replace type checking");
await ok(typeConfig.compilerOptions?.erasableSyntaxOnly === true, "source uses Node-erasable TypeScript only");

const sourceFiles = await readdir(new URL("../src/", import.meta.url));
await ok(!sourceFiles.some((name) => name.endsWith(".js")), "maintained source has no unchecked JavaScript");

const clientBundle = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
await ok(
  clientBundle.startsWith('window.__ModuleLoader__.load({ id: "@local/dsh-mcp-manager"'),
  "client bundle registers through window.__ModuleLoader__",
);
await ok(clientBundle.trimEnd().endsWith("} });"), "client bundle closes the factory");

const hostBundle = await readFile(new URL("../lib/index.js", import.meta.url), "utf8");
await ok(hostBundle.includes('from "./store.js"'), "host bundle keeps relative ESM imports (bundle: false)");

const clientSource = await readFile(new URL("../src/client.ts", import.meta.url), "utf8");
await ok(clientSource.includes("fetch(resolveApiUrl("), "client resolves its single API exit through resolveApiUrl");
await ok(!/fetch\(\s*["'`]\/api\//.test(clientSource), "client has no raw root-absolute fetch left");
await ok(clientSource.includes('"x-dsh-mcp-manager": "1"'), "client sends the mutation marker header");

console.log(`\nbuild: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
