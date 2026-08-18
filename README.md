# 星璃笔记

自托管的 Markdown 知识库：笔记三栏 + 可分享文档站 + MCP 大脑 + 日历时间面。  
产品规格与设计在 `docs/`。一期 P0 九条与 P1 三条都已落地：账号与注册码、工作区成员与笔记本 ACL、
三栏编辑与双链、导入导出、附件与回收站、分享与文档站、AI 与 `ai_index`、MCP 钥匙、S3/WebDAV 备份、
身份生命周期，以及广场、评论与纠错。

日历（[设计 16](docs/设计/16-日历与任务.md)）也已落地 P0 与 P1：日 / 周 / 月 / 议程四视图、笔记任务
双向同步（块锚定位，勾选回写正文）、拖拽改期与拉伸改时长、撤销、提醒、重复规则、今天页与日记入口、
ICS 订阅与导出，以及 `list_tasks` / `list_events` / `create_task` / `complete_task` 四个 MCP 工具。

## 启动

需要 Node 22、pnpm、Docker。

```bash
copy .env.example .env
pnpm install
# 目录名含中文时 Docker 需要项目名
set COMPOSE_PROJECT_NAME=knowledge
pnpm db:up
pnpm db:push
pnpm test
pnpm dev
```

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
node scripts/mock-ai-provider.mjs   # verify-ai-index、verify-ai-write-review 要它（:19091）
node scripts/mock-webdav.mjs        # verify-backup 要它（:19092）
```

**所有脚本的账号都从环境变量取**（见 `scripts/creds.mjs`），仓库里不留任何凭据：

```bash
$env:KB_EMAIL="你的邮箱"; $env:KB_PASSWORD="你的密码"   # PowerShell
node scripts/verify-manage.mjs      # 备份 / 导出 / 审计 / 冻结 / 通知 / 导入
node scripts/verify-mcp-keys.mjs    # MCP 钥匙的额度、范围、档位、轮换、吊销
node scripts/verify-gaps.mjs        # 分享类型、分享总览、回收站销毁、搜索、标签
node scripts/verify-feed.mjs        # 圈子动态、泄漏检查、转正、公开主页、评论
node scripts/verify-calendar-core.mjs   # 日历 CRUD、时区边界、ACL、409、今天页、日记
node scripts/verify-calendar-sync.mjs   # 笔记 ↔ 日历双向同步、块锚、版本合并、脱链
node scripts/verify-calendar-recur.mjs  # 重复展开、单次例外、「此后全部」
node scripts/verify-calendar-ics.mjs    # ICS 导出与订阅（含 SSRF 拦截）、日历 MCP 四工具
node --experimental-strip-types scripts/verify-transfer.mjs   # 导入向导、zip 导出、版本裁剪（约 3 分钟）
node scripts/verify-manage-cdp.mjs
node scripts/verify-gaps-cdp.mjs
node scripts/verify-feed-cdp.mjs
node scripts/verify-transfer-cdp.mjs
node scripts/verify-calendar-cdp.mjs
node scripts/verify-editor-cdp.mjs      # 编辑器内核、字节保真、快捷键、公式与任务列表
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
