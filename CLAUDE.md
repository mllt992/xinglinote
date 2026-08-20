# CLAUDE.md

写给在本仓库工作的 Claude Code。**先读「协作红线」再动手。**

---

## 0. 协作红线（最高优先级）

### 0.1 禁止私自创建 / 切换分支

本仓库常有**多个会话并行共用同一个工作树**，分支状态是共享的。

- **禁止**在未被明确要求时执行 `git checkout -b` / `git switch -c` / `git branch <name>`——包括「为了安全起见先开个分支」这类自作主张。
- **禁止**切换分支（`git checkout <branch>` / `git switch <branch>`）、`git worktree add`、`git stash`。这些都会把别的会话正在编辑的文件从脚下抽走。
- 默认**就在当前分支（通常是 `main`）上直接改**。
- 确有必要开分支时：先说明理由，等用户明确同意，再动手。

### 0.2 不碰别人的改动

- 工作树里常有**不是你造成的** `M` / `??` 文件。不要 `git checkout --` 、`git restore`、`git reset --hard`、`git clean` 去「清理」它们。
- `git add` 只加自己改的具体路径，**不要 `git add -A` / `git add .`**——会把别的会话的半成品一起提交。
- 提交 / 推送只在用户明确要求时做。

### 0.3 其他

- 凭据一律走环境变量，**任何密码、token、PAT 都不许写进文件或提交**（见 `scripts/creds.mjs` 的做法）。
- `.env` 是本地真实配置，不要覆盖；要改示例改 `.env.example`。

---

## 1. 这是什么

**星璃笔记**：自托管 Markdown 知识库。笔记三栏 + 可分享文档站 + MCP 大脑 + 日历时间面。
pnpm workspace monorepo，全 TypeScript ESM。

```
apps/api      Hono + drizzle-orm + postgres，HTTP API 与 MCP 服务端
apps/web      React 19 + Vite + Tailwind v4 + Radix/shadcn + CodeMirror 6
apps/worker   后台任务（索引、备份、提醒）
packages/shared  跨端共用：类型、Markdown 解析渲染（markdown-it）
packages/core    纯业务逻辑与 ACL，单测在这里最密
scripts/      验收脚本（verify-*.mjs）与假服务
docs/         产品规格 / 功能设计 / 技术架构 / 主题手册
themes/       主题包（出厂皮肤 mono-modern「现代墨白」）
```

## 2. 文档优先

改任何功能前，先读对应设计文档；**代码与文档冲突时以文档为准**，要改行为先改文档。

- 业务对错 → `docs/设计/`（索引：[00-索引与约定](docs/设计/00-索引与约定.md)）
- 进程 / 表 / 接口 → `docs/架构/`（索引：[00-索引](docs/架构/00-索引.md)）
- UI 规范 → [docs/设计/14-UI规范与方案.md](docs/设计/14-UI规范与方案.md)
- 编辑器 → [docs/设计/17-编辑器方案.md](docs/设计/17-编辑器方案.md)

## 3. 常用命令

```bash
pnpm install
pnpm db:push        # 同步 schema（apps/api/src/db/push.ts，不是 drizzle-kit 迁移）
pnpm dev            # api + web + worker 并行
pnpm typecheck      # 五个 tsconfig 全过一遍
pnpm test           # shared + core + api 的 node:test
pnpm lint
```

**数据库连哪里，只看 `.env` 的 `DATABASE_URL`**，可以是任何一个 Postgres 实例。
`apps/api/src/env.ts` 不给兜底默认值，没配就直接报错——宁可起不来，也好过连到别的库上。

`docker-compose.yml` 里**没有数据库服务**。自带的那个在单独的 [compose.db.yml](compose.db.yml)，
是「懒得自己装 Postgres」时才叠加的可选件：

```bash
set COMPOSE_PROJECT_NAME=knowledge   # 目录名含中文，Docker 需要显式项目名
pnpm db:up          # = docker compose -f docker-compose.yml -f compose.db.yml --profile db up -d db
pnpm db:down        # 停掉它
```

已经有现成实例的，**不要**跑 `pnpm db:up`——它会去抢 `POSTGRES_HOST_PORT`（默认 5432），
把别的实例顶掉或自己起不来。这台机器上就并存着好几个 Postgres 容器，踩过这个坑。
真要两边都留着，在 `.env` 里改 `POSTGRES_HOST_PORT` 错开端口。

拆成两个文件而不是在主文件里挂 profile，是因为 **compose 的变量插值是全局的，不看 profile**：
`POSTGRES_USER` 这些一旦写成 `${VAR:?}` 必填，哪怕根本不启用 db 服务，光跑 `docker compose config`
都会因为缺变量报错，把所有接外部数据库的人挡在门外。反过来在主文件写 `${DATABASE_URL_INTERNAL:?}`
也会同样堵死自带库那条路。这个坑踩过两次，别再往回改。

- 前端 http://127.0.0.1:12098 ，API http://127.0.0.1:12099/api/healthz
- 第一个注册的用户是实例管理员。

## 4. 验收脚本

`scripts/verify-*.mjs` 是真接口 / 真界面的验收，**改完功能应当跑对应那几个**，比单测更能发现回归。

- 需要 `pnpm dev` 起着。
- 带 `-cdp` 的还需要 Chrome 开 `--remote-debugging-port=9223` 且已登录。
- 账号从环境变量取：`$env:KB_EMAIL` / `$env:KB_PASSWORD`（PowerShell）。
- 少数脚本要先起假服务：`node scripts/mock-ai-provider.mjs`（:19091）、`node scripts/mock-webdav.mjs`（:19092）。

对应关系见 [README.md](README.md#校验)。

## 5. 代码约定

- **禁止浏览器原生弹窗**：`alert` / `confirm` / `prompt` 一律不用，改用 `useToast()` / `useConfirm()` / `usePrompt()`。ESLint 已经拦（`eslint.config.mjs`），这条来自设计 14 §11.3。
- TypeScript `strict`，ESM，`allowImportingTsExtensions`；包间用 `workspace:*` 引用，import 走 `@kb/shared`、`@kb/core`。
- 数据库 schema 集中在 `apps/api/src/db/schema.ts`；改表后跑 `pnpm db:push`。
- 路由按域拆在 `apps/api/src/routes/`，可复用逻辑放 `apps/api/src/lib/`。
- 相对路径（如 `DATA_DIR=./data`）**按仓库根解析**，不是进程 cwd——api 与 worker 必须落在同一个 data 目录。
- 注释、文档、提交信息用中文，跟现有风格保持一致。
