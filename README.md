# 星璃笔记

自托管的 Markdown 知识库：笔记三栏 + 可分享文档站 + MCP 大脑 + 日历时间面。  
产品规格与设计在 `docs/`。一期 P0 九条与 P1 三条都已落地：账号与注册码、工作区成员与笔记本 ACL、
三栏编辑与双链、导入导出、附件与回收站、分享与文档站、AI 与 `ai_index`、MCP 钥匙、S3/WebDAV 备份、
身份生命周期，以及广场、评论与纠错。

日历（[设计 16](docs/设计/16-日历与任务.md)）P0 / P1 / P2 全部落地：日 / 周 / 月 / 议程四视图、笔记任务
双向同步（块锚定位，勾选回写正文）、拖拽改期与拉伸改时长、撤销、提醒、重复规则、今天页与日记入口、
ICS 订阅与导出，以及 `list_tasks` / `list_events` / `create_task` / `complete_task` 四个 MCP 工具；
P2 补上浏览器推送（自签 VAPID、自己加密，不经第三方）、多选批量操作、日历模板、去年今日与周回顾、
以及「AI 从纪要提待办」——只给候选，人确认过才写库。

画图（[设计 17 §3.0](docs/设计/17-编辑器方案.md)）走 ` ```mermaid ` 代码块：预览与编辑器里就地渲染、
渲染库按需加载，外加「AI 画图」——说一句话生成或改一张图，画得出来才让插进正文。

编辑器还有：Vim keymap（默认关、按需加载）、表格的可视化编辑（增删行列 / 对齐 / 拖列宽，改的仍是
Markdown 源码），以及**协同编辑与远端光标**——CRDT 只做在线这一层，落库仍然回
`notes.body_md` + `note_versions`，所以搜索、导出、MCP、行级 diff 一个都没动
（[设计 17 §3.4](docs/设计/17-编辑器方案.md)）。连不上就静默退回单机自动保存。

## 启动

需要 Node 22、pnpm、Docker。

```bash
copy .env.example .env
# 编辑 .env，把 DATABASE_URL 指向你的 Postgres
pnpm install
pnpm db:push
pnpm test
pnpm dev
```

数据库连哪里只由 `.env` 的 `DATABASE_URL` 决定，用哪个 Postgres 实例都行。
手上没有现成的，可以用仓库自带的 —— 它在单独的 [compose.db.yml](compose.db.yml) 里，是可选件：

```bash
# 目录名含中文时 Docker 需要项目名
set COMPOSE_PROJECT_NAME=knowledge
pnpm db:up
```

它会按 `.env` 里的 `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` 建库，
并把 `POSTGRES_HOST_PORT`（默认 5432）映射到本机。已经有别的 Postgres 占着 5432 的，改这个值错开。

可选 Redis（embedding 缓存，不配也能跑）：`pnpm redis:up`，`.env` 写 `REDIS_URL=redis://127.0.0.1:6379`。

- 前端：http://127.0.0.1:12098（固定监听 IPv4）
- API：http://127.0.0.1:12099/api/healthz

第一个注册的用户是实例管理员，并自动拥有个人工作区。

## 校验

```bash
pnpm typecheck
pnpm test
```

`scripts/verify-*.mjs` 是接口与界面的验收脚本，需要 `pnpm dev` 起着；带 `-cdp` 的还需要 Chrome 开
`--remote-debugging-port=9223` 并已登录。另有两个脚本要先起本地假服务，否则会以连接被拒失败：

```bash
node scripts/mock-ai-provider.mjs   # verify-ai-index、verify-ai-write-review、verify-agents 要它（:19091）
node scripts/mock-webdav.mjs        # verify-backup 要它（:19092）
node scripts/mock-push-gateway.mjs  # verify-push 要它（:19093）
```

**所有脚本的账号都从环境变量取**（见 `scripts/creds.mjs`），仓库里不留任何凭据：

```bash
$env:KB_EMAIL="你的邮箱"; $env:KB_PASSWORD="你的密码"   # PowerShell
node scripts/verify-manage.mjs      # 备份 / 导出 / 审计 / 冻结 / 通知 / 导入
node scripts/verify-mcp-keys.mjs    # MCP 钥匙的额度、范围、档位、轮换、吊销
node scripts/verify-mcp-tools.mjs   # MCP 工具合同：动态减清单、搜索、替换、今天、幂等、审计
node scripts/verify-gaps.mjs        # 分享类型、分享总览、回收站销毁、搜索、标签
node scripts/verify-saved-shares.mjs # 收到的分享：自动收下、移出不救活、手工再存
node scripts/verify-notebook-move.mjs    # 笔记本跨工作区搬迁：内容、附件、搜索归属、双链、权限
node scripts/verify-site-review.mjs      # 文档站：编辑申请、管理员过审才上线
node scripts/verify-feed.mjs        # 圈子动态、泄漏检查、转正、公开主页、评论
node scripts/verify-agents.mjs      # 智能体 CRUD、动态 @、评论回复
node scripts/verify-calendar-core.mjs   # 日历 CRUD、时区边界、ACL、409、今天页、日记
node scripts/verify-calendar-sync.mjs   # 笔记 ↔ 日历双向同步、块锚、版本合并、脱链
node scripts/verify-calendar-recur.mjs  # 重复展开、单次例外、「此后全部」
node scripts/verify-calendar-ics.mjs    # ICS 导出与订阅（含 SSRF 拦截）、日历 MCP 四工具
node scripts/verify-calendar-p2.mjs     # 批量操作、模板、去年今日 / 周回顾、AI 提待办不写库、推送
node --experimental-strip-types scripts/verify-push.mjs   # 推送投递闭环：VAPID 验签、密文解回原文、失效端点停用
node scripts/verify-collab.mjs      # 协同：两个客户端真收敛、落库、只读发不出更新、无权连不上
node scripts/verify-hardening.mjs   # 安全加固：CSP 头、验证码、出站 SSRF 护栏、目录归属、搜索分页
node scripts/verify-nav.mjs         # 导航页：公开读、管理员配置、站内路径、非法 URL、清理
node --experimental-strip-types scripts/verify-transfer.mjs   # 导入向导、zip 导出、版本裁剪（约 3 分钟）
node scripts/verify-manage-cdp.mjs
node scripts/verify-gaps-cdp.mjs
node scripts/verify-feed-cdp.mjs
node scripts/verify-transfer-cdp.mjs
node scripts/verify-calendar-cdp.mjs
node scripts/verify-editor-cdp.mjs      # 编辑器内核、字节保真、快捷键、公式、图与任务列表
node --experimental-strip-types scripts/verify-zip.mjs   # 不需要账号
```

## 主题

出厂皮肤是「现代墨白」。设置 → 外观 可改主题色、导入 `theme.json`。  
制作说明：[docs/主题开发手册.md](docs/主题开发手册.md)

## 部署

生产用 Docker：一个镜像三个命令（api / worker / migrate），只暴露一个 HTTP 入口。
见 [docs/部署.md](docs/部署.md)。

```bash
docker compose --profile app --profile tls up -d --build
```
