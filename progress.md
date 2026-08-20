# 数据库连不上（ECONNREFUSED → 认证失败）排查与整改记录

日期：2026-08-20

## 结论

三件事叠在一起。前两个是故障，第三个是我自己造成的、已回退：

1. **`postgres18` 容器掉出了 docker 网络** → 宿主机 5432 无人监听 → `ECONNREFUSED`。
2. **库名 / 账号与 `.env` 对不上** → 网络修好后变成 `28P01 password authentication failed`。
3. **我一度按仓库里写死的 `kb`/`knowledge` 建了角色**，未先征求意见。该角色已删除，改为你指定的 `xinglinote`。

当前状态：应用可正常连库，数据完好（users=22 / notes=77 / workspaces=70 / notebooks=98，46 张表）。

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

## ⚠️ 遗留问题（需要你拍板）

1. **孤儿卷 `knowledge_pgdata`**
   排查早期我照 `CLAUDE.md` §3 跑了 `pnpm db:up`，创建了 `knowledge-db-1`（`pgvector/pgvector:pg16`）并占用 5432 —— 该容器**已被你删除**，但卷还在。
   卷里是一份**过期**的库（44 张表，缺 `calendar_templates`/`moderation_reviews`/`note_collab`/`push_subscriptions`）。
   我当时误判它是主库，对它跑过一次 `pnpm db:push`（属无用操作，未影响 postgres18）。
   确认不需要后可清理：`docker volume rm knowledge_pgdata`。

2. ~~`pnpm db:up` 仍会与 postgres18 抢 5432~~ → **已解决，见下节**。

3. ~~`CLAUDE.md` §3 未更新~~ → **已解决，见下节**。

## 问题 4：自带 db 服务改为默认不启动

参考主流自托管项目（Gitea、Outline、Plausible、Miniflux、Sentry self-hosted）的通行做法，两条：

1. **应用只认 `DATABASE_URL`**，不假定库一定是 compose 起的 —— 问题 3 已做到。
2. **自带 `db` 服务放进 profile，默认不启动**。用自带库就显式 `--profile db`；接外部实例就只配 `.env`。

原先这个仓库正好是反的：`db` 没有 profile 所以永远默认启动，`api`/`worker` 反而在 `app` profile 里。
现在：

```yaml
db:
  profiles: ["db", "app"]   # 不开 profile 就不会有人来抢宿主机 5432
                            # 挂在 app 下是为了整套部署时能被 depends_on 拉起来
```

验证（`docker compose config --services`）：

| 命令 | 启动的服务 |
|---|---|
| 默认（不带 profile） | *（空）* |
| `--profile db` | `db` |
| `--profile app` | `db` `migrate` `api` `worker` |

配套改动：

| 文件 | 改动 |
|---|---|
| [package.json](package.json) | `db:up` → `docker compose --profile db up -d db`；新增 `db:down` |
| [CLAUDE.md](CLAUDE.md) §3 | 常用命令里去掉 `db:up`；新增说明：连哪个库只看 `DATABASE_URL`，自带 db 是可选便利品，已有实例就别跑 `db:up` 否则抢端口 |
| [README.md](README.md) | 快速开始改为「先配 `DATABASE_URL`」，自带库降级为可选段落 |
| [docs/部署.md](docs/部署.md) | 补充 profile 说明；**接外部库时要删掉 `api`/`worker`/`migrate` 三处 `environment.DATABASE_URL` 覆盖**，否则它们仍指向 `@db:5432` |

> 已知取舍：compose 里三个应用服务显式把 `DATABASE_URL` 覆盖成 `@db:5432`，
> 这让自带库的路径开箱即用，但走外部库时必须手工删掉那三行。
> 想彻底干净可以再引一个 `DATABASE_URL_INTERNAL` 变量，暂未做。

## 顺带核实过的兼容性

担心 `postgres:18` 不带 pgvector 会跑不了 schema，实测**不是问题**：

- `apps/api/src/db/push.ts` 只需 `CREATE EXTENSION pgcrypto`，标准镜像自带；
- `ai_chunks.embedding` 是 `double precision[]`，不是 pgvector 的 `vector` 类型；
- `schema.ts` 中无 `vector(...)` 列。

## 下一步

1. 重启 `pnpm dev` —— 之前那次启动时库不通，日志里 `seed skipped`，种子没跑。
2. 定「遗留问题」第 2 点，再改 `CLAUDE.md`。
3. 确认后清理 `knowledge_pgdata`。

## 改动清单

- 代码 / 文档：`docker-compose.yml`、`apps/api/src/env.ts`、`.env.example`、`docs/部署.md`、本文件。
- 本地未提交：`.env`。
- **未执行任何 git 提交 / 推送，未切分支。**
- Docker：`docker network connect bridge postgres18`。
- 数据库（`postgres18`，与 BoyaERP 共用实例）：建 `xinglinote` 角色、`knowledge` 改名为 `xinglinote`、移交属主、删除我先前误建的 `kb` 角色。BoyaERP 的 `boya_erp_local` / `boya_erp_drill` 未触碰。
