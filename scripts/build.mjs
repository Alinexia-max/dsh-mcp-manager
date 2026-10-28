// 从 src 生成可发布的 lib：Host 侧保持 ESM 一文件一产物，客户端打成 CJS 并塞进
// `window.__ModuleLoader__.load` 的 factory 里（宿主只认这种形态）。
// 先在暂存目录构建，成功后再替换 lib，避免构建失败时破坏已可安装的产物。

import { access, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { build } from "esbuild";

const PACKAGE_ID = "@local/dsh-mcp-manager";
// 面板标题旁的版本号与 package.json 保持一致，避免两处手改。
const PACKAGE_VERSION = JSON.parse(await readFile(resolve("package.json"), "utf8")).version ?? "0.0.0";
const outputDirectory = resolve("lib");
const stagingDirectory = resolve(`.dsh-mcp-manager-build-${randomUUID()}`);
const backupDirectory = resolve(`.dsh-mcp-manager-build-backup-${randomUUID()}`);
let previousOutputMoved = false;
let published = false;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

try {
  await build({
    entryPoints: ["src/index.ts", "src/servers.ts", "src/store.ts", "src/discovery.ts"],
    outdir: stagingDirectory,
    outbase: "src",
    bundle: false,
    format: "esm",
    platform: "node",
    target: "node20",
  });

  await build({
    entryPoints: ["src/client.ts"],
    outfile: join(stagingDirectory, "client.js"),
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2022",
    external: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "react-dom/client",
      "@deepseek-ai/dsh-client-ui-primitives",
    ],
    minify: true,
    define: {
      "process.env.NODE_ENV": "\"production\"",
      __DSMM_VERSION__: JSON.stringify(PACKAGE_VERSION),
    },
    // 客户端产物本身就是 CJS：`module` 由下面的 banner 在 factory 作用域内提供，
    // 不是真正的 ESM 全局，所以这条告警不适用。
    logOverride: { "commonjs-variable-in-esm": "silent" },
    banner: {
      js: `window.__ModuleLoader__.load({ id: "${PACKAGE_ID}", factory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;`,
    },
    footer: { js: "return module.exports;\n} });" },
  });

  if (await exists(outputDirectory)) {
    await rename(outputDirectory, backupDirectory);
    previousOutputMoved = true;
  }

  try {
    await rename(stagingDirectory, outputDirectory);
    published = true;
  } catch (error) {
    if (previousOutputMoved) await rename(backupDirectory, outputDirectory);
    throw error;
  }

  if (published && previousOutputMoved) await rm(backupDirectory, { recursive: true, force: true });
} finally {
  await rm(stagingDirectory, { recursive: true, force: true });
  if (published && previousOutputMoved && (await exists(backupDirectory))) {
    await rm(backupDirectory, { recursive: true, force: true });
  }
}

console.log(`[dsh-mcp-manager] 已生成 Host 与客户端产物（${PACKAGE_ID}）`);
