# 数据库连不上（ECONNREFUSED → 认证失败）排查与整改记录

日期：2026-08-20

## 结论

三件事叠在一起。前两个是故障，第三个是我自己造成的、已回退：

1. **`postgres18` 容器掉出了 docker 网络** → 宿主机 5432 无人监听 → `ECONNREFUSED`。
2. **库名 / 账号与 `.env` 对不上** → 网络修好后变成 `28P01 password authentication failed`。
3. **我一度按仓库里写死的 `kb`/`knowledge` 建了角色**，未先征求意见。该角色已删除，改为你指定的 `xinglinote`。

当前状态：应用可正常连库，数据完好（users=22 / notes=77 / workspaces=70 / notebooks=98，46 张表）。

排查中留下的孤儿卷 `knowledge_pgdata`（223 篇笔记）已确认为测试数据并删除，详见「遗留问题」第 1 点。

---

## 问题 1：postgres18 端口映射失效

### 现象

`docker ps` 显示 `5432/tcp`，而非正常的 `0.0.0.0:5432->5432/tcp`；`netstat -ano | findstr ":5432"` 无输出。

### 根因

配置里有映射，运行时没落地：

```
HostConfig.PortBindings  →  {"5432/tcp":[{"HostIp":"","HostPort":"5432"}]}   ← 配置在
NetworkSettings.Ports    →  {"5432/tcp":[]}                                   ← 实际为空
NetworkSettings.Networks →  {}                                                ← 关键：没接任何网络
```

容器 `NetworkMode=bridge` 却没有 IP，`docker network inspect bridge` 显示该网络上 **0 个容器**。
没有网络 → 没有容器 IP → docker-proxy 无法建立端口转发。

容器内 postgres 本身一直正常：`/proc/net/tcp` 有 `00000000:1538`（0x1538 = 5432），`pg_isready` 通过。

### 尝试与结果

| 手段 | 结果 |
|---|---|
| `docker restart postgres18` | ❌ 无效，`Networks` 仍为空 |
| `docker network connect bridge postgres18` | ✅ **有效** |

**修复命令：**

```bash
docker network connect bridge postgres18
```

修复后 `Networks = bridge(IP=172.17.0.2)`，`0.0.0.0:5432->5432/tcp`，宿主机 LISTENING。

> 这是 Docker Desktop 的网络状态异常（引擎 / WSL2 重启后容器没被挂回 bridge）。
> 若复发且该命令也不管用，重启 Docker Desktop 或 `wsl --shutdown`。
> `postgres18` 数据在具名卷 `postgres18_data`（挂到 `/var/lib/postgresql`），restart 安全；
> 但**不要**随手 `docker rm` 重建，除非确认 run 参数一致。

## 问题 2：库名 / 账号统一为 xinglinote

原先仓库里到处写死的是 `kb` / `knowledge`。按要求改为：

- 数据库：`xinglinote`
- 用户：`xinglinote`
- 密码：只存在于仓库根的 `.env`（已被 `.gitignore` 忽略），**不落任何提交内容**

在 `postgres18` 上执行（原 `knowledge` 库是**改名**而非新建，数据原样保留）：

```sql
CREATE ROLE xinglinote LOGIN PASSWORD '<见 .env>';
ALTER DATABASE knowledge RENAME TO xinglinote;
ALTER DATABASE xinglinote OWNER TO xinglinote;
-- 切到 xinglinote 库
ALTER SCHEMA public OWNER TO xinglinote;
-- 循环把 public 下 46 张表与全部序列的 owner 改为 xinglinote
```

随后回退了我之前建的 `kb`：先 `REVOKE` 掉库 / schema / 表 / 序列及默认权限，再 `DROP ROLE kb`。
当前可登录角色只剩 `postgres` 与 `xinglinote`。

验证：

```
连接成功: { cu: 'xinglinote', db: 'xinglinote', users: '22', notes: '77', ws: '70', tables: '46' }
建表/删表权限: OK
```

## 问题 3：去掉写死的凭据

凭据一律改成从环境变量读，代码 / 文档 / compose 里不再出现真实账号密码。

| 文件 | 改动 |
|---|---|
| [docker-compose.yml](docker-compose.yml) | `POSTGRES_USER/PASSWORD/DB` 改为 `${...:?提示}`（缺失即报错，不静默用默认值）；宿主机端口改为 `${POSTGRES_HOST_PORT:-5432}`；healthcheck 改用 `$$POSTGRES_USER`/`$$POSTGRES_DB`；三处 `DATABASE_URL` 改为变量拼接 |
| [apps/api/src/env.ts](apps/api/src/env.ts) | 删掉 `?? "postgres://kb:kb@..."` 兜底，新增 `requireEnv()`，缺 `DATABASE_URL` 直接抛错 —— 避免「以为连上了其实连的是别的库」 |
| [.env.example](.env.example) | 用 `your-db-user` 等占位符，补 `POSTGRES_*` 四项及说明 |
| [docs/部署.md](docs/部署.md) | `.env` 示例不再给真实账号，改为「自己定」+ `openssl rand` 生成，`DATABASE_URL` 用变量拼接 |
| `.env`（未提交） | 填入真实的 `POSTGRES_USER/PASSWORD/DB/HOST_PORT` 与 `DATABASE_URL` |

`pnpm typecheck` 五个 tsconfig 全过。
`docker compose config` 变量正确解析（`POSTGRES_DB: xinglinote`、`published: "5432"`）。

---

## 遗留问题（均已处理）

1. ~~孤儿卷 `knowledge_pgdata`~~ → **已删除**（确认是测试数据）

   排查早期我照 `CLAUDE.md` §3 跑了 `pnpm db:up`，创建了 `knowledge-db-1`（`pgvector/pgvector:pg16`）并占用 5432 —— 该容器**已被你删除**，但卷还在。

   我一度把它描述成「过期副本」，**这个判断是错的**。它比现用库少 4 张新表（`calendar_templates`/`moderation_reviews`/`note_collab`/`push_subscriptions`，是我当时对它跑 `pnpm db:push` 补上的），
   但**内容不是子集，是分叉**：

   | | 孤儿卷 `knowledge_pgdata` | 现用库 `postgres18/xinglinote` |
   |---|---|---|
   | notes | **223** | 77 |
   | note_versions | **1672** | 157 |
   | attachments | **35** | 7 |
   | workspaces | **87** | 70 |
   | users | 13 | **22** |
   | 最新笔记 | 2026-08-18 05:58 | 2026-08-20 10:36 |

   **处理结果：已确认那 223 篇是测试数据，卷已删除**（`docker volume rm knowledge_pgdata`）。
   删除前导出的备份留在桌面：`knowledge_pgdata-备份-20260820.dump`（pg_dump 自定义格式，0.33 MB），
   确认无用后可自行删掉。`postgres18_data`（现用库）未触碰。

   教训记一笔：我最初凭「表少 4 张」就断定它是过期副本并建议删除，实际表结构新旧
   和数据多少是两回事。删数据前按行数、时间戳逐项比对过再下结论。

2. ~~`pnpm db:up` 仍会与 postgres18 抢 5432~~ → **已解决，见下节**。

3. ~~`CLAUDE.md` §3 未更新~~ → **已解决，见下节**。

## 问题 4：自带 db 服务改为默认不启动

参考主流自托管项目（Gitea、Outline、Plausible、Miniflux、Sentry self-hosted）的通行做法，两条：

1. **应用只认 `DATABASE_URL`**，不假定库一定是 compose 起的 —— 问题 3 已做到。
2. **自带 `db` 服务放进 profile，默认不启动**。用自带库就显式 `--profile db`；接外部实例就只配 `.env`。

原先这个仓库正好是反的：`db` 没有 profile 所以永远默认启动，`api`/`worker` 反而在 `app` profile 里。

### 走过的弯路：profile 挡不住全局插值

第一版只是给 `db` 加了 `profiles: ["db", "app"]`。看起来对，实测**不成立**：

**compose 的变量插值是全局的，不看 profile。** 只要文件里写了 `${POSTGRES_USER:?...}`，
哪怕根本不启用 `db` 服务，光跑 `docker compose config` 都会报错：

```
error while interpolating services.db.environment.POSTGRES_USER:
required variable POSTGRES_USER is missing a value
```

也就是说，任何接外部数据库、没设 `POSTGRES_*` 的人，连 `docker compose config` 都跑不了。
反过来把主文件写成 `${DATABASE_URL_INTERNAL:?...}` 必填，又会同样堵死自带库那条路
（实测 B/C/D 三个场景全报错）。**`:?` 在 compose 里对任何「可选」的东西都不能用。**

### 最终方案：拆成两个文件 + 一个回落变量

- [docker-compose.yml](docker-compose.yml)：只有应用，**不含任何数据库实例**。
  三个服务的连库地址是 `${DATABASE_URL_INTERNAL:-${DATABASE_URL}}` —— 不配就回落到
  `DATABASE_URL`，数据库有真实主机名时零配置即可；只有当 `DATABASE_URL` 写的是
  `127.0.0.1`（容器里指容器自己）才需要单独配 `DATABASE_URL_INTERNAL`。
- [compose.db.yml](compose.db.yml)：自带的 Postgres，叠加才生效。
  叠加时会把三个应用服务的 `DATABASE_URL` 直接覆盖成 `@db:5432`，
  所以走自带库这条路**不需要**配 `DATABASE_URL_INTERNAL`。

四种场景实测（`docker compose config --services`）：

| 场景 | 命令 | 服务 | 容器连的库 |
|---|---|---|---|
| A 外部库，`POSTGRES_*` 全不设 | `--profile app` | `migrate` `api` `worker` | 回落到 `DATABASE_URL` ✅ |
| B 自带库整套部署 | `-f … -f compose.db.yml --profile app` | `db` `migrate` `api` `worker` | `@db:5432` ✅ |
| C 只起开发库 | `-f … -f compose.db.yml --profile db` | `db` | — |
| D 默认不带 profile | *（无）* | *（空）* | — |

场景 A 是关键：第一版在这里直接报错，现在通了。

配套改动：

| 文件 | 改动 |
|---|---|
| [package.json](package.json) | `db:up` / `db:down` 改为 `-f docker-compose.yml -f compose.db.yml --profile db …` |
| [.env.example](.env.example) | `DATABASE_URL` 提为唯一必填项并说明无兜底；新增注释掉的 `DATABASE_URL_INTERNAL`；`POSTGRES_*` 降级为「只在用自带库时才需要，接自己的库可整段删掉」 |
| [CLAUDE.md](CLAUDE.md) §3 | 去掉 `db:up`；写明主文件不含数据库、拆文件的原因，并标注这个坑踩过两次别往回改 |
| [README.md](README.md) | 快速开始改为「先配 `DATABASE_URL`」，自带库降级为可选段落 |
| [docs/部署.md](docs/部署.md) | 「起服务」拆成「接自己的数据库」（推荐）与「用自带的」两条路，各给完整命令 |

## 问题 5：线上部署 —— 构建失败的根因是 npm 源，不是配置

远端是一台内网 NAS（Debian 12，绿联），经内网穿透暴露：外网 `:12097` → NAS `127.0.0.1:12099`，
域名 `wiki.mllt.cc`。数据库用机器上已有的 `postgres_xrilang` 容器（库名 `xinglinote`），
应用容器经 `docker-compose.override.yml` 接到 `xl_net` 与之同网。

### 现象与根因

`docker compose --profile app up -d --build` 反复失败：

```
failed to solve: process "/bin/sh -c pnpm install --frozen-lockfile" did not complete successfully: exit code: 1
```

日志里全是 `error (23)` 重试和 `Tarball download average speed 6 KiB/s`。实测两个源：

| 源 | 速度 |
|---|---|
| registry.npmjs.org | **88 KB/s** |
| registry.npmmirror.com | **5.5 MB/s** |

**64 倍。** 换源后 441 个包 **50 秒**装完，构建一次通过。跟配置、跟 Node 版本都没关系。

### 落到仓库里的改动

不写死镜像源（对国外网络反而更慢），开成 build arg：

| 文件 | 改动 |
|---|---|
| [Dockerfile](Dockerfile) | `base` 阶段加 `ARG NPM_REGISTRY=https://registry.npmjs.org`，用 `ENV npm_config_registry` 传给 npm/pnpm；**同时设 `COREPACK_NPM_REGISTRY`** —— 这个仓库用 corepack 装 pnpm，不设的话 corepack 自己仍走官方源 |
| [docker-compose.yml](docker-compose.yml) | 三个服务的 `build:` 展开成长格式，加 `args: NPM_REGISTRY: ${NPM_REGISTRY:-https://registry.npmjs.org}` |
| [.env.example](.env.example) | 注释掉的 `NPM_REGISTRY` + 说明 |
| [docs/部署.md](docs/部署.md) | 新增「构建卡在装依赖 / 直接失败」小节，给现象、原因、数据 |

验证：`docker build --check` 无告警；带 `--build-arg` 时镜像内 `npm config get registry` 是 npmmirror，
不带时回落 `registry.npmjs.org`。

### 部署结果

`xinglinote` 库建了 **46 张表**，api healthy，外网 `:12097` 首页与 `/api/healthz` 均 200，
`wiki.mllt.cc` 也已确认可正常访问。

### 遗留

- **worker 显示 unhealthy**（功能正常）。`HEALTHCHECK` 写在共用的 `runtime` 阶段去打 `/api/healthz`，
  但三个镜像同源，worker / migrate 根本不起 HTTP 服务，必然失败。
  修法：compose 里给 worker 覆盖 `healthcheck: {disable: true}`。**未做。**
- **服务器上那份源码没有 `.git`**，是手工拷的，Dockerfile 还被就地改过，已与仓库分叉。
  建议改成 `git clone` + `git pull`。**未做。**

## 顺带核实过的兼容性

担心 `postgres:18` 不带 pgvector 会跑不了 schema，实测**不是问题**：

- `apps/api/src/db/push.ts` 只需 `CREATE EXTENSION pgcrypto`，标准镜像自带；
- `ai_chunks.embedding` 是 `double precision[]`，不是 pgvector 的 `vector` 类型；
- `schema.ts` 中无 `vector(...)` 列。

## 下一步

1. 重启 `pnpm dev` —— 之前那次启动时库不通，日志里 `seed skipped`，种子没跑。
2. 桌面上的 `knowledge_pgdata-备份-20260820.dump` 确认无用后删掉。

## 改动清单

- 代码 / 文档：`docker-compose.yml`、新增 `compose.db.yml`、`apps/api/src/env.ts`、
  `package.json`、`.env.example`、`CLAUDE.md`、`README.md`、`docs/部署.md`、本文件。
- 本地未提交：`.env`。
- 桌面：`knowledge_pgdata-备份-20260820.dump`（删卷前留的 pg_dump，可自行删除）。
- Docker：`docker network connect bridge postgres18`；临时容器 `kb-tmp-inspect` 用完已删；
  孤儿卷 `knowledge_pgdata` 已删除。`postgres18_data`（现用库）未触碰。
- 数据库（`postgres18`，与 BoyaERP 共用实例）：建 `xinglinote` 角色、`knowledge` 改名为 `xinglinote`、移交属主、删除我先前误建的 `kb` 角色。BoyaERP 的 `boya_erp_local` / `boya_erp_drill` 未触碰。
