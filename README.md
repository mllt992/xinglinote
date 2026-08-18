# 星璃笔记

自托管的 Markdown 知识库：笔记三栏 + 可分享文档站 + MCP 大脑。  
产品规格与设计在 `docs/`。一期 P0 九条与 P1 三条都已落地：账号与注册码、工作区成员与笔记本 ACL、
三栏编辑与双链、导入导出、附件与回收站、分享与文档站、AI 与 `ai_index`、MCP 钥匙、S3/WebDAV 备份、
身份生命周期，以及广场、评论与纠错。

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
`--remote-debugging-port=9223` 并已登录。**所有脚本的账号都从环境变量取**（见 `scripts/creds.mjs`），
仓库里不留任何凭据：

```bash
$env:KB_EMAIL="你的邮箱"; $env:KB_PASSWORD="你的密码"   # PowerShell
node scripts/verify-manage.mjs      # 备份 / 导出 / 审计 / 冻结 / 通知 / 导入
node scripts/verify-mcp-keys.mjs    # MCP 钥匙的额度、范围、档位、轮换、吊销
node scripts/verify-gaps.mjs        # 分享类型、分享总览、回收站销毁、搜索、标签
node scripts/verify-feed.mjs        # 圈子动态、泄漏检查、转正、公开主页、评论
node --experimental-strip-types scripts/verify-transfer.mjs   # 导入向导、zip 导出、版本裁剪
node scripts/verify-manage-cdp.mjs
node scripts/verify-gaps-cdp.mjs
node scripts/verify-feed-cdp.mjs
node scripts/verify-transfer-cdp.mjs
node --experimental-strip-types scripts/verify-zip.mjs   # 不需要账号
```

## 主题

出厂皮肤是「现代墨白」。设置 → 外观 可改主题色、导入 `theme.json`。  
制作说明：[docs/主题开发手册.md](docs/主题开发手册.md)
