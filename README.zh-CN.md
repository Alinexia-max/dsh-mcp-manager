# dsh-mcp-manager

在 DeepSeek Harness（dsh）的「设置 → MCP 服务器」里添加、连接、启停 MCP 服务器，无需手改 profile 的 `cordis.patch.yml`。

- **Host 半边**：`lib/index.js`，注册 `prefix` 路由 `/api/dsh-mcp-manager`，并用 `ctx.plugin()` 在运行时挂载 `@deepseek-ai/dsh-mcp-client`。
- **Client 半边**：`lib/client.js`，通过 `window.__ModuleLoader__.load()` 注册 React 面板到 `settings.section` 槽位。
- 两端只通过 `fetch` 通信，配置存在 `$DSH_HOME/mcp-manager/servers.json`（权限 0600）。

## 安装

```bash
cd dsh-mcp-manager
npm install
npm run build

# profile 名按实际部署填（桌面版是 desktop，可用 dsh plugin list 查看）
dsh plugin --profile desktop add <本目录的绝对路径>
# 重启 dsh，刷新页面 → 设置 → MCP 服务器
```

`dsh` 不在 PATH 时先装 CLI：`npm i -g @deepseek-ai/dsh`。注意 `add` 要传本目录的绝对路径，
不要 `cd` 进去之后再 `add ./dsh-mcp-manager`（那样会指向不存在的子目录）。

发布到 npm 或 GitHub 直装时，`lib/` 必须一起提交（`.gitignore` 未忽略它）。

## 使用

面板按**来源**分组，每组对应一个配置文件：

| 来源 | 配置文件 | 可写 |
| --- | --- | --- |
| DSH | `$DSH_HOME/mcp-manager/servers.json` | 是 |
| CodeBuddy | `~/.codebuddy/mcp.json`（可用 `DSMM_CODEBUDDY_MCP` 覆盖） | 否，只能导入 |

1. 「添加服务器」，选择传输方式：
   - **stdio**：填命令（如 `npx`）、参数（每行一个）、环境变量（每行 `KEY=VALUE`）、可选工作目录。
   - **streamable-http**：填 `http(s)://` 端点与请求头（每行 `KEY=VALUE`）。
2. 保存后插件会立刻挂载它；连接成功即显示「已连接」，其工具以 `mcp__<服务器名>__<工具名>` 出现在对话中。
3. 「查看工具」可确认某个服务器公布了哪些工具；「重连」会先卸载再重新连接；「停用」立即注销它的工具。
4. 工具条可按来源/状态过滤、按名称或命令搜索；点击分组标题可折叠。
5. CodeBuddy 组里的条目只读（显示 `sse` 之类不支持的传输时会标红且不能导入）。点「导入」会把它复制成本地
   DSH 服务器并立刻挂载；密钥由 Host 直接读原文取得，不经过浏览器。

## 安全约定

- 密钥（`env` / `headers` 的值）**永不回传明文**，接口只返回键名与 `***`。编辑时保留 `***` 表示沿用旧值，删掉整行才会真的删除。
- 所有请求先校验 `Host` / `Origin` / `sec-fetch-site`，只接受 loopback 与宿主 `trustedHosts`。
- 写操作要求自定义头 `x-dsh-mcp-manager: 1` 与 `application/json`，逼迫跨站请求走预检，本路由不回 CORS。
- 配置文件损坏时**拒绝写入**（返回 `error.store.corrupt`），不会覆盖原有内容。

## 已验证 / 未验证

- 已验证（`npm test`）：`tsc --noEmit` 严格类型检查、双端构建产物形态、存储层与密钥语义、路由的 CRUD 与安全栅栏。
- 未验证：真实宿主里的连接与面板渲染。需要在你自己的 dsh 实例上跑一遍（见「安装」）。

## 排障

**面板显示「无法加载 @deepseek-ai/dsh-mcp-client」**
说明宿主的 profile 里没有这个包。插件会依次从 profile 目录、dsh CLI 入口、当前工作目录解析它；
全部失败时按宿主的包管理器补装即可：

```bash
$DSH_HOME/profiles/web$ npm i @deepseek-ai/dsh-mcp-client   # 或 pnpm add
# 然后重启 dsh
```

**状态一直是「连接中」**
`dsh-mcp-client` 的首次连接由 MCP SDK 的 60 秒请求超时约束；stdio 命令写错或被墙时可能等满一分钟。
先确认命令能在终端直接跑通，再用「重连」重试。

## 已知限制

- 由 profile 的 Loader row 挂载的 MCP 服务器显示为「外部挂载」，只能查看工具，不能在此编辑（那属于 profile 配置）。
- CodeBuddy 侧是**只读聚合**：不回写对方配置，也无法停用对方进程里的连接。开关只对导入后的本地记录有意义。
- 只支持 stdio 与 streamable-http；CodeBuddy 里的 `sse` 条目会列出来但不允许导入。
- 导入时 `${VAR}` 占位符会原样保留，面板会在该行标注需要手动替换的字段。
- 「连接是否存活」只有本插件自己挂载的服务器有权威状态；外部挂载的只能按工具是否存在推断。
- 动态挂载使用 Cordis 的 `ctx.plugin()`。若宿主将来收紧该路径，只需替换 `src/servers.ts` 里的挂载实现。
- 不支持 MCP 资源订阅与 prompt 模板（`dsh-mcp-client` 本身也不支持）。
