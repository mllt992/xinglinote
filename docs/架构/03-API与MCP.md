# 03 HTTP API 与 MCP

## 1. 总约定

- 浏览器 API 前缀 `/api/v1`。
- 公开页是文档路由，不是 JSON：`/` `/u/:handle` `/s/:ws/:nb` `/p/:token` `/login` `/register`。
- JSON 响应：

```json
{ "ok": true, "data": {} }
{ "ok": false, "error": { "code": "FORBIDDEN", "message": "..." } }
```

`code` 只用设计 00 那张表。校验失败可带 `fields: { title: "目录下已有同名笔记" }`。

- 认证：Cookie session。未登录调 `/api/v1/**`（除 health、公开读）→ 401。
- 分页：`?cursor=&limit=` 默认 20，上限 100。
- 幂等：创建分享、注册码批量等可带 `Idempotency-Key`。
- 写操作带 `X-Requested-With: fetch`。

Actor 从 session 或 MCP Bearer 注入，handler 禁止自己解析 Cookie 后再抄一套权限。

---

## 2. HTTP 路由清单

### 2.1 账号与实例

| 方法 | 路径 | 谁 | 说明 |
|---|---|---|---|
| GET | `/api/v1/meta` | 公开 | 实例名、是否零用户、开放注册/码、广场开否、导航开否 |
| POST | `/api/v1/auth/register` | 公开 | email, password, handle, displayName, code? |
| POST | `/api/v1/auth/verify-email` | 公开 | token |
| POST | `/api/v1/auth/login` | 公开 | email, password |
| POST | `/api/v1/auth/logout` | 登录 | |
| POST | `/api/v1/auth/forgot` | 公开 | email |
| POST | `/api/v1/auth/reset` | 公开 | token, password |
| GET | `/api/v1/me` | 登录 | 资料、个人工作区 id、instanceRole、appearance、themeId、accent、storage |
| GET | `/api/v1/me/storage` | 登录 | 用量拆分、是否可申请、当前 pending |
| GET | `/api/v1/me/service-requests` | 登录 | 我的申请历史 |
| POST | `/api/v1/me/service-requests` | 登录 | `{ kind, requestedBytes, reason? }` |
| DELETE | `/api/v1/me/service-requests/:id` | 登录 | 取消自己的 pending |
| GET | `/api/v1/themes` | 登录/公开 meta | 已安装主题列表 |
| POST | `/api/v1/themes/import` | 视策略 | zip |
| POST | `/api/v1/themes/:id/enable` | 登录 | 选用 |
| DELETE | `/api/v1/themes/:id` | 视策略 | 卸载非 builtin |
| PATCH | `/api/v1/me/appearance` | 登录 | appearance, themeId, accent |
| PATCH | `/api/v1/me` | 登录 | displayName, handle, bio, avatar |
| POST | `/api/v1/me/password` | 登录 | old, new |
| GET | `/api/v1/admin/settings` | 实例管理员 | |
| PATCH | `/api/v1/admin/settings` | 同上 | 注册策略、广场、限额、导航开关与文案 |
| POST | `/api/v1/admin/smtp/test` | 同上 | |
| CRUD | `/api/v1/admin/codes` | 同上 | 列表回完整码（`code_prefix`）；旧行只有前缀则 `code` 为空 |
| GET | `/api/v1/admin/users` | 同上 | 列表带用量与 pending；`?hasPending=` |
| GET | `/api/v1/admin/users/:id` | 同上 | 详情：用量拆分 + 申请历史 |
| PATCH | `/api/v1/admin/users/:id` | 同上 | 封禁、解封、升/降管理员、分配 `storageQuotaBytes`（`null` 恢复默认） |
| GET | `/api/v1/admin/service-requests` | 同上 | 服务申请队列 |
| PATCH | `/api/v1/admin/service-requests/:id` | 同上 | `{ status: approved\|rejected, grantedQuotaBytes?, adminNote? }` |

### 2.2 工作区

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/workspaces` | 我加入的 |
| POST | `/api/v1/workspaces` | 建普通区 |
| GET/PATCH | `/api/v1/workspaces/:id` | |
| POST | `/api/v1/workspaces/:id/transfer` | 转让 Owner |
| DELETE | `/api/v1/workspaces/:id` | 确认名 |
| GET/POST | `/api/v1/workspaces/:id/members` | |
| PATCH/DELETE | `/api/v1/workspaces/:id/members/:uid` | 改角色 / 移出（body: migratePrivate, revokeMcp） |
| POST | `/api/v1/workspaces/:id/invites` | |
| POST | `/api/v1/invites/:token/accept` | |

### 2.3 笔记内核

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/workspaces/:id/notebooks` | |
| POST/PATCH/DELETE | `.../notebooks` | DELETE=trash |
| POST | `/api/v1/notebooks/:nb/move` | workspaceId；整本跨工作区搬迁，两端都要 owner/admin |
| GET | `.../notebooks/:nb/tree` | 目录树 |
| PATCH | `/api/v1/notebooks/:nb/folders/order` | 整串重写目录 `sort_key`，要本的 `edit` |
| PATCH | `/api/v1/notebooks/:nb/notes/order` | 整串重写笔记 `sort_key`，要本的 `edit` |
| POST | `.../folders` | |
| PATCH | `.../folders/:fid` | 改名/移动；换父目录时新 `sort_key` 排到目标同级最后 |
| DELETE | `.../folders/:fid` | trash |
| POST | `/api/v1/notes` | notebookId, folderId, title? |
| GET/PATCH | `/api/v1/notes/:id` | PATCH: bodyMd, title, published, aiIndex, expectedVersion, force? |
| DELETE | `/api/v1/notes/:id` | trash |
| POST | `/api/v1/notes/:id/move` | `notebookId?`, `folderId?`；同工作区内改目录或换本。换本且未给 `folderId` 时落到目标本根。目标目录已有同名笔记则拒绝 |
| GET | `/api/v1/notes/:id/versions` | |
| POST | `/api/v1/notes/:id/versions/:v/restore` | |
| POST | `/api/v1/notes/:id/presence` | heartbeat |
| GET | `/api/v1/notes/:id/collaborators` | 谁能一起编这篇：工作区内有效名单（`can=edit|read`、权限来自 `workspace|notebook|owner`）+ `canInvite`。协同没有开关，跟着 ACL 走，这个接口就是把那份名单摊开给人看（设计 17 §3.4） |
| GET | `/api/v1/notes/:id/backlinks` | |
| GET | `/api/v1/notes/:id/mentions` | 未链接提及 |
| GET | `/api/v1/notes/:id/graph` | 局部图 |
| GET | `/api/v1/search` | q, scope, notebookId, tag |
| POST | `/api/v1/notes/:id/attachments` | multipart |
| GET | `/api/v1/files/:id` | 鉴权后流 |

### 2.4 分享与站

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/shares` | targetType, targetId, password?, expiresAt? |
| GET | `/api/v1/shares` | mine 或 workspaceId= 本区 |
| GET/POST | `/api/v1/notes/:id/shares` | 单篇 / 单节 |
| GET/POST | `/api/v1/notebooks/:id/shares` | 整本 |
| GET/POST | `/api/v1/folders/:id/shares` | 目录 |
| GET/POST | `/api/v1/attachments/:id/shares` | 附件 |
| PATCH/DELETE | `/api/v1/shares/:id` | 改密续期 / 取消 |
| POST | `/api/v1/public/shares/:token/unlock` | password |
| GET | `/api/v1/public/shares/:token` | 解锁后的内容 JSON（页面也可 SSR） |
| GET | `/api/v1/notebooks/:id/site` | 本站状态：已上线 / 待审 / 谁能发 |
| PATCH | `/api/v1/notebooks/:id/site` | Admin 当场上下线；Editor 申请或撤回；Admin 带 `action=approve\|reject` 审申请 |
| GET | `/api/v1/workspaces/:id/site-requests` | 本区待审的文档站申请，仅 Admin / Owner |
| GET | `/api/v1/me/saved-shares` | 我收下的（仅 `active`）；不含 token、不含正文 |
| POST | `/api/v1/me/saved-shares` | 手工保存 / 重新保存；`shareToken` 或 `site`（ws slug + nb slug） |
| DELETE | `/api/v1/me/saved-shares/:id` | 移出（`dismissed`，不撤销原链接） |
| GET | `/api/v1/me/saved-shares/:id` | 元数据 + 是否仍有效 |
| GET | `/api/v1/me/saved-shares/:id/content` | 与公开投影同一套；`?noteId=`；已失效统一 NOT_FOUND |
| GET | `/api/v1/me/saved-shares/:id/open` | 302 到当前 `/p/{token}` 或 `/s/{ws}/{nb}` |

### 2.5 评论、动态、AI、MCP、回收站、备份

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/v1/comments` | |
| PATCH | `/api/v1/comments/:id/review` | `{ status: visible\|rejected\|hidden }`；作者可隐藏/取消隐藏自己的评论 |
| GET/POST | `/api/v1/corrections` | |
| POST | `/api/v1/corrections/:id/review` | accept/reject |
| GET | `/api/v1/feed/public` | 广场时间线；`?tag=` 按标签筛；`?q=` 模糊搜正文 / 作者 / 标签；回 `posts` + `now` |
| GET | `/api/v1/feed/public/tags` | 广场最近可见帖里出现次数最多的标签 |
| GET | `/api/v1/feed/public/updates?since=` | 广场自 `since` 起的新帖数、有新回复的帖数；回 `newPosts` `repliedPosts` `now` |
| GET | `/api/v1/feed/public/catalog` | 广场公开目录；回已发布文档站 + 公开收录的目录/整本分享（`kind=site\|folder\|notebook`）+ 文档站公开文章，不含正文 |
| GET | `/api/v1/feed/workspaces/:id` | 圈子时间线；成员；`?tag=` / `?q=` 同上 |
| GET | `/api/v1/feed/workspaces/:id/tags` | 圈子热门标签 |
| GET | `/api/v1/feed/workspaces/:id/updates?since=` | 圈子同上的增量计数；成员 |
| GET | `/api/v1/posts/:id` | 单条动态；广场未登录可读，圈子要成员。广场关闭时公开帖对外 404 |
| GET/POST | `/api/v1/posts` | scope, workspaceId；POST 可带 `attachmentIds` |
| POST | `/api/v1/posts/attachments` | 发帖前暂存附件（multipart `file`） |
| GET/DELETE | `/api/v1/posts/attachments/:id` | 看 / 删；广场未登录可读 |
| POST | `/api/v1/posts/:id/like` | |
| PUT/DELETE | `/api/v1/posts/:id/favorite` | 收藏 / 取消 |
| GET/POST | `/api/v1/posts/:id/comments` | 一层回复；登录直发，广场访客先审。评论 DTO 带 `authorKind` / `agent`。GET 对作者/版主附带自己的 `hidden` 评论，并回 `pendingReplies`（本帖尚未完成的智能体回复） |
| GET | `/api/v1/agents` | 公开：启用中的智能体，供 @ 补全；`?scope=square\|circle`。DTO 带 `avatarUrl` |
| GET | `/api/v1/agents/:id/avatar` | 智能体头像；没有上传图则 404 |
| GET/POST | `/api/v1/admin/agents` | 实例管理员；POST 建智能体 |
| POST | `/api/v1/admin/agents/avatar` | 上传头像，回 `sha256` / `mime` |
| POST | `/api/v1/admin/agents/:id/test` | 用当前配置 ping 模型，回一句预览或失败原因 |
| PATCH/DELETE | `/api/v1/admin/agents/:id` | 改 / 软删 |
| POST | `/api/v1/posts/:id/report` | `{ reason, note? }`；先交 AI |
| POST | `/api/v1/posts/:id/appeal` | `{ note? }`；仅 AI 下架后的作者 |
| POST | `/api/v1/posts/:id/promote` | 转正为笔记 |
| POST | `/api/v1/notes/:id/excerpt-to-post` | |
| GET | `/api/v1/moderation/queue` | state=review\|recheck\|approved\|rejected，q=正文，author=作者，kind，page |
| PATCH | `/api/v1/moderation/:id` | action=approve \| reject；待审和已处理都能改，note 为说明 |
| POST | `/api/v1/ai/write` | 写作，回 diff |
| POST | `/api/v1/ai/ask` | SSE 流 |
| GET/POST | `/api/v1/workspaces/:id/ai/provider` | 列出渠道及工作区模型配置 / 新增渠道。渠道字段：`name`、`baseUrl`、`apiKey`、`models[]`、`workspaceIds[]` |
| PATCH/DELETE | `/api/v1/ai/providers/:id` | 修改渠道连接、模型目录、绑定范围或启用状态 / 删除未被工作区引用的渠道 |
| PATCH | `/api/v1/workspaces/:id/ai/settings` | 指定 `chatProviderId` + `chatModel`、可选 `embeddingProviderId` + `embeddingModel`，以及 `autoEmbed` |
| CRUD | `/api/v1/mcp-tokens` | POST 响应含一次性 secret 与配置 JSON；`workspaceIds[]`（兼容单数 `workspaceId`） |
| POST | `/api/v1/mcp-tokens/:id/rotate` | |
| GET | `/api/v1/workspaces/:id/mcp-audit` | `tokenId` / `tool` / `result` / `limit`；Admin 看本区，本人看自己的 |
| GET | `/api/v1/workspaces/:id/trash` | |
| POST | `/api/v1/trash/:type/:id/restore` | |
| DELETE | `/api/v1/trash/:type/:id` | purge |
| GET | `/api/v1/workspaces/:id/backups` | 工作区管理员 | 目标与最近 100 条运行记录（凭据/口令不回传） |
| POST | `/api/v1/workspaces/:id/backups/targets` | 同上 | `{ type: webdav\|s3, endpoint, credentials, … }` |
| GET | `/api/v1/admin/backups` | 实例管理员 | 实例级目标与运行记录 |
| POST | `/api/v1/admin/backups/targets` | 同上 | 同上，scope=instance |
| PATCH/DELETE | `/api/v1/backup-targets/:id` | 对应管理员 | 改配置 / 删目标（顺带清运行记录） |
| POST | `/api/v1/backup-targets/:id/test` | 同上 | 写一个小文件再删 |
| POST | `/api/v1/backup-targets/:id/run` | 同上 | |
| GET | `/api/v1/backup-targets/:id/objects` | 直接发现目标前缀下的远端包 | Owner/Admin |
| POST | `/api/v1/backup-targets/:id/objects/inspect` | checksum、解密、格式、引用和附件预检，生成短期计划 | Owner/Admin |
| GET | `/api/v1/backup-targets/:id/objects/:name/download` | 下载已列举的远端包 | Owner/Admin |
| POST | `/api/v1/backup-restore-plans/:id/execute` | 按计划恢复；替换模式先建检查点 | Owner/实例 Admin |
| POST | `/api/v1/backup-restore-plans/:id/drill` | 隔离事务恢复演练并自动销毁 | Owner/实例 Admin |
| GET | `/api/v1/notifications` | |
| POST | `/api/v1/notifications/read` | |

导入导出：`POST /api/v1/import`（job）、`GET /api/v1/export?notebookId=`（job + 下载 token）。

### 2.6 导航页

业务规则见 [设计 19](../设计/19-导航页.md)。

| 方法 | 路径 | 谁 | 说明 |
|---|---|---|---|
| GET | `/api/v1/nav` | 视开关 | `{ enabled, title, subtitle, groups: [{ id, title, description, sortKey, links }] }`；关总闸时 `enabled=false` 且 `groups=[]`；未公开且未登录 → 401 |
| GET | `/api/v1/nav/icons/:sha256` | 视引用 | 只出已被站点引用的图标；管理员可预览尚未保存的哈希 |
| GET | `/api/v1/admin/nav` | 实例管理员 | 完整目录，不受总闸影响 |
| POST | `/api/v1/admin/nav/groups` | 同上 | `{ title, description? }` |
| PATCH | `/api/v1/admin/nav/groups/:id` | 同上 | 改标题 / 简介 |
| DELETE | `/api/v1/admin/nav/groups/:id` | 同上 | 级联删站点并释放图标引用 |
| POST | `/api/v1/admin/nav/links` | 同上 | `{ groupId, title, url, description?, iconSha256?, iconMime?, fetchIcon? }`；`fetchIcon` 默认 true |
| PATCH | `/api/v1/admin/nav/links/:id` | 同上 | 可改组、可 `fetchIcon: true` 重抓 |
| DELETE | `/api/v1/admin/nav/links/:id` | 同上 | |
| POST | `/api/v1/admin/nav/reorder` | 同上 | `{ groups?: [{id,sortKey}], links?: [{id,groupId?,sortKey}] }` |
| POST | `/api/v1/admin/nav/favicon` | 同上 | `{ url }` → `{ sha256, mime }` 或 `{ sha256: null }`；10 分钟 20 次 |

`NavLinkDTO`：`id, groupId, title, url, description, iconUrl, sortKey`。`iconUrl` 是本域路径，不是外站。

### 2.7 日历与任务

业务规则见 [设计 16](../设计/16-日历与任务.md)。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/workspaces/:id/calendar` | `from`、`to`（ISO）、`layers=task,event,note`；返回已展开重复实例 |
| GET | `/api/v1/workspaces/:id/calendar/inbox` | 无 `due_at` 的任务 + 按来源笔记分组 |
| POST | `/api/v1/workspaces/:id/calendar/items` | 建 task / event |
| GET | `/api/v1/calendar/items/:id` | 单条详情（含 `bodyMd` / `updatedAt` / `canEdit`），给弹窗与 `?item=` 深链 |
| PATCH | `/api/v1/calendar/items/:id` | 改；带 `ifUnmodifiedSince` 做弱冲突校验，冲突回 409 + 最新对象 |
| DELETE | `/api/v1/calendar/items/:id` | 软删（`trashed_at`），可撤销 |
| POST | `/api/v1/calendar/items/:id/complete` | `{ done, occurrenceStart? }`；`source=note` 时回写笔记 `- [x]` |
| POST | `/api/v1/calendar/items/:id/reschedule` | `{ startsAt, endsAt?, occurrenceStart?, scope: 'one'\|'following' }` |
| GET/PUT | `/api/v1/calendar/items/:id/reminders` | 每条最多 5 个 |
| POST | `/api/v1/workspaces/:id/calendar/quick-add` | `{ text, commit }`；`commit=false` 只回解析预览，确认后才写库 |
| POST | `/api/v1/calendar/items/:id/restore` | 从回收站恢复 |
| POST | `/api/v1/calendar/items/:id/detach` | 断链条目转成独立任务 |
| GET | `/api/v1/workspaces/:id/today` | 今日日程 + 待办 + 逾期 + 今天改过的笔记 |
| POST | `/api/v1/workspaces/:id/calendar/diary` | `{ date? }`；落到 slug 为 `diary` 的笔记本，同一天复用同一篇 |
| GET/POST | `/api/v1/workspaces/:id/calendar/subscriptions` | 外部 ICS 只读订阅，每区上限 5；建时校验 SSRF 并立刻入队同步 |
| PATCH/DELETE | `/api/v1/calendar/subscriptions/:sid` | 改名 / 启停；删订阅一并清掉它带进来的条目 |
| POST | `/api/v1/calendar/subscriptions/:sid/sync` | 手动同步，10 次 / 10 分钟 |
| GET/POST | `/api/v1/workspaces/:id/calendar/feed-tokens` | 导出订阅地址，`scope=mine\|workspace` |
| POST | `/api/v1/calendar/feed-tokens/:fid/rotate` | 轮换，旧地址立即失效 |
| DELETE | `/api/v1/calendar/feed-tokens/:fid` | 吊销 |
| GET | `/calendar/feed/:token.ics` | **不在 `/api/v1` 下**，匿名可读，返回 `text/calendar` |
| POST | `/api/v1/workspaces/:id/calendar/batch` | `{ ids[≤200], action, … }`；逐条鉴权、允许部分成功，回 `{changed, snapshot, failed[]}`，`action=revert` 拿快照撤销 |
| GET/POST | `/api/v1/workspaces/:id/calendar/templates` | 模板；建时可传 `fromItemIds` 由服务端折算成相对偏移 |
| PATCH/DELETE | `/api/v1/calendar/templates/:tid` | `scope=workspace` 的只有 owner / admin 能改 |
| POST | `/api/v1/calendar/templates/:tid/apply` | `{ date, preview? }`；`preview=true` 只算不写 |
| GET | `/api/v1/workspaces/:id/calendar/on-this-day` | 往年同月日的笔记与条目，只读 |
| GET | `/api/v1/workspaces/:id/calendar/review` | 周回顾；统计只算调用者可见的内容 |
| POST | `/api/v1/workspaces/:id/calendar/extract-tasks` | AI 从纪要提待办，**只回候选、一条都不写库** |
| POST | `/api/v1/workspaces/:id/calendar/tasks-from-note` | 人确认后才落库，`source=ai`，一次最多 20 条 |
| GET | `/api/v1/push/config` | 推送开没开、VAPID 公钥 |
| GET/POST | `/api/v1/push/devices` | 本人的推送设备，按 endpoint upsert，每人最多 10 台 |
| DELETE | `/api/v1/push/devices/:id` | 移除一台 |
| POST | `/api/v1/push/test` | 给自己发一条测试推送，6 次 / 分钟 |
| POST | `/api/v1/admin/push/vapid` | 生成 / 轮换 VAPID；轮换会把所有旧订阅一并置 `gone` |
| WS | `/api/v1/notes/:id/collab` | 协同房间（y-websocket 协议：`0`=sync、`1`=awareness）。**升级前**跑 `noteAccess(id, user, 'edit')`：能编辑给 `mode=write`，只能读给 `mode=read`（收得到光标、发不出更新，服务端丢弃其 update 帧），读都不能读**一律回 404**——403 会告诉对方这篇存在 |

### 2.8 项目

业务规则见 [设计 23](../设计/23-项目.md)。写操作记 `audit_logs`，`target_type=project` 或 `project_task`。Viewer 写接口 403；私有项目对非创建者 404。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/workspaces/:id/projects` | `?archived=1` 看归档；默认不含归档。带回健康度与本周节奏 |
| POST | `/api/v1/workspaces/:id/projects` | 建项目；未归档上限 200 |
| GET | `/api/v1/workspaces/:id/projects/running` | 当前用户正在跑的一只计时 |
| GET | `/api/v1/projects/:id` | 详情：任务树、里程碑、脉搏、正在跑的表 |
| PATCH | `/api/v1/projects/:id` | 改标题/状态/色/期/可见性。改可见性或归档走 archive ACL |
| POST | `/api/v1/projects/:id/archive` | 归档；列表默认不再出现，详情只读 |
| POST | `/api/v1/projects/:id/unarchive` | 拉回，落成 `done` |
| POST | `/api/v1/projects/:id/tasks` | 建任务；可选挂笔记、一层子任务 |
| PATCH | `/api/v1/project-tasks/:id` | 改字段；不回写笔记正文 |
| POST | `/api/v1/project-tasks/:id/move` | `{ status, beforeId? }` 看板拖拽 |
| POST | `/api/v1/project-tasks/:id/reschedule` | `{ startAt, dueAt }` 甘特改期 |
| DELETE | `/api/v1/project-tasks/:id` | 连子任务和工时一起删 |
| POST | `/api/v1/projects/:id/time/start` | 开表；同一人已有一只会先停 |
| POST | `/api/v1/projects/:id/time/stop` | 停表才落 `seconds` |
| GET/POST | `/api/v1/projects/:id/time` | 账本；POST 补录 |
| POST | `/api/v1/projects/:id/milestones` | 建里程碑 |
| PATCH/DELETE | `/api/v1/project-milestones/:id` | 改 / 删里程碑 |

导出内容只含标题、时间与回本实例的 `URL`，**不含 `DESCRIPTION`**，任务导成 `VEVENT`（标题带 `☐` / `☑`）而不是 `VTODO`。
订阅抓取每一跳都重新做 SSRF 校验（私有网段一律拒），条件请求带 `If-None-Match`，连续失败 5 次自动停用并通知创建者。

`CalendarItemDTO`：

```json
{
  "id": "uuid",
  "occurrenceStart": "2026-08-20T07:00:00Z",
  "kind": "task",
  "title": "交周报",
  "allDay": false,
  "startsAt": null, "endsAt": null, "dueAt": "2026-08-20T07:00:00Z",
  "timezone": "Asia/Shanghai",
  "status": "open",
  "priority": 3,
  "recurring": true,
  "source": "note",
  "sourceNote": { "id": "uuid", "title": "本周计划" },
  "linkState": "linked",
  "assignee": null,
  "canEdit": true,
  "updatedAt": "..."
}
```

重复条目的写操作**必须带回 `occurrenceStart`**，服务端才知道改的是哪一次；缺失时按整个序列处理。

---

## 3. 关键 DTO

`NoteDTO`（编辑器用）：

```json
{
  "id": "uuid",
  "workspaceId": "uuid",
  "notebookId": "uuid",
  "folderId": null,
  "title": "会议纪要",
  "aliases": [],
  "bodyMd": "...",
  "published": false,
  "aiIndex": true,
  "version": 12,
  "updatedAt": "...",
  "updatedBy": { "id": "", "displayName": "" },
  "path": ["工作", "会议", "会议纪要"],
  "canEdit": true
}
```

`SaveNoteBody`：`{ expectedVersion, bodyMd?, title?, published?, aiIndex?, force?: false }`  
冲突：`409 CONFLICT_VERSION` + `data: { version, updatedBy, bodyMd }`。

**保存的响应也是一份完整的 `NoteDTO`，`canEdit` 一个都不能少。** 前端拿它整个换掉手上的笔记对象，
缺字段等于告诉界面「这篇变只读了」——编辑器锁上、协同房间被拆、自动保存自己停掉，
用户只看见「人还在编辑页却存不进去」，非刷新不可。以后新增写接口同理。

---

## 4. MCP 传输

- 端点：`POST {PUBLIC_URL}/api/v1/mcp`（Streamable HTTP）。
- 头：`Authorization: Bearer kbk_{8}_{secret}`。
- **只有 POST 有语义**。这是个纯请求-响应的端点，不提供服务端主动推的 SSE 流，所以
  `GET`（客户端探 SSE）和 `DELETE`（客户端结束会话）一律回 **405 + `Allow: POST`**：
  协议允许这么答，客户端见到 405 就不会再试。这两个动词早先落在 404 上，有的客户端把它
  读成「端点不存在」而不是「这里没有 SSE」，于是不停重连——看着就像服务不稳定。
  唯一的例外是**不带 `Authorization` 的 GET**，仍回 401 + `WWW-Authenticate`，
  否则发现授权服务器那条路（RFC 9728）会被一起堵死。
- 备选：同镜像提供 `knowledge-mcp-stdio`，从 stdin 读，把请求转到该端点，给只支持 stdio 的客户端。
- 初始化后 `tools/list` 按钥匙 rw/feed/delete **动态减工具**，不要列出再 403（减少 Agent 胡调）。每个工具带 `annotations`（`readOnlyHint` / `destructiveHint` / `idempotentHint`）。
- `initialize.result.instructions` 写清用法：先 `get_me`，搜用 `search_notes`，改正文先 `get_note` 拿 version。
- 协议方法：`initialize`、`ping`（回 `{}`）、`tools/list`、`tools/call`。未知 `notifications/*` 回 204。其它未知方法记失败审计，`action` 用 `mcp.{method}`，`details` 写 `VALIDATION` +「不支持的方法：{method}」，不要一律写成 `mcp.request`。`ping` / `initialize` / `tools/list` 成功不写审计，否则客户端保活会把日志刷满。
- 创建类工具公开 UUID 参数 `client_request_id`，所有写工具也认 HTTP 头 `Idempotency-Key`。`mcp_idempotency` 以钥匙、工具名和键为主键，保存参数哈希及首次成功结果 10 分钟；同键不同参数返回 `IDEMPOTENCY_KEY_REUSED`，并发同参请求等待首个结果。
- 错误：JSON-RPC `error.data` 为 `{ code, message, ...fields }`，`code` 同 HTTP。`CONFLICT_VERSION` 带当前 `version`。
  未捕获异常一律 `{ code: "INTERNAL", message: "服务器错误" }`，**不要**把 `fetch failed`、堆栈、出站 cause 写进 JSON-RPC——那是 Node/undici 的网络层原文，客户端会误以为 MCP 网关自己挂了。真正原因写进程日志。
  出站打 AI / Embedding 失败必须先收成 `AI_PROVIDER_ERROR`（超时 / DNS / TLS / 连接被拒），人话写 `message`。`search_notes` 默认 hybrid：向量支挂了就只回关键词，并在 `retrieval_metadata.degraded=true`；纯 `semantic` 才把 `AI_PROVIDER_ERROR` 抛给调用方。

鉴权链严格按 [设计 11 §5.1](../设计/11-MCP.md)。

### 4.1 连接寿命：api 与反代必须成对配

MCP 的每次工具调用都是 POST，而 **POST 不可安全重试**——连接在请求已经写进去之后被对端
关掉，就是一次无法挽回的失败。这类失败不会稳定复现，只会表现成「偶发失败、重试一下又好了」，
所以「谁先关闭空闲的复用连接」必须是确定的：**永远让反向代理先关**。

| 位置 | 参数 | 值 |
|---|---|---|
| [docker/Caddyfile](../../docker/Caddyfile) | `transport http { keepalive }` | 30s |
| [apps/api/src/index.ts](../../apps/api/src/index.ts) | `server.keepAliveTimeout` | 75s |
| 同上 | `server.headersTimeout` | 80s |

约束是 `反代 keepalive < api keepAliveTimeout < api headersTimeout`。Node 的出厂值只有 5s，
比 Caddy 出厂的 2m 短得多，**两边都不配就正好落在这条竞态里**。换别的反代
（Nginx `keepalive_timeout`、Traefik `idleConnTimeout`）同样要压到 75s 以下。

Caddy 另外配了 `lb_try_duration 5s`：api 容器重启的那几秒里拨号失败会重试，而不是直接把 502
甩给客户端。它只对「请求还没发出去」的失败生效，所以对 POST 也是安全的。

### 4.2 审计只记调用，不记正文

`audit_logs.details.arguments` 里超过 200 字的字符串一律截断成 `…（共 N 字，正文见笔记本身）`。
正文在 `notes` 与 `note_versions` 里已经各存了一份，审计再存第三份，批量导入时会把库撑大
好几倍，大 jsonb 的插入本身也会把这次写请求拖慢。短字段（id、标题、标签）原样保留，
足够回答「谁在什么时候调了什么」。

失败行的 `details` 是 `{ code, message }`（业务码 + 人话），设置页「最近 MCP 调用」和审计页都要露出来，不能只渲染 `result=error`。

审计写失败**不回滚、也不影响本次调用的返回值**：笔记已经落库了还回一个错，会自动重试的
Agent 就会照着错误再建一遍，于是出现重复笔记。审计断了只在进程日志里喊一声。

---

## 5. 工具 JSON Schema（稳定合同）

名称与参数一期冻结，改名走新工具旧工具并存至少一个小版本。

### get_me

无参。返回用户、工作区、rw、notebookMode、notebooks[{id,title,slug,visibility}]、expiresAt、require_ai_index、allow_private_notebooks、allow_delete。

### list_notebooks

`{ limit?: number, cursor?: string }`。返回 `{ items, notebooks: items, next_cursor, has_more }`，按 `title ASC, id ASC` 稳定排序。

### list_folder

```
{ notebook_id: string, folder_id?: string, limit?: number, cursor?: string }
→ { items: [{type,id,title}], folders: [...], notes: [...], next_cursor, has_more }
```

### search_notes

```
{ query: string, notebook_id?: string, tag?: string,
  mode?: "keyword"|"semantic"|"hybrid", limit?: number }
→ {
    hits: [{ note_id, title, notebook_id, path, version, updated_at,
             excerpt, relevance_score? }],
    retrieval_metadata: { mode, hit_count, truncated, degraded? }
  }   // 默认 8，≤20，excerpt≤360；note_id 可直接传给 get_note
     // hybrid 的 Embedding 失败时 degraded=true，hits 仍是关键词结果
```

### get_note

```
{ id: string, offset?: number, max_chars?: number }
→ { id, title, path, body_md, version, tags, ai_index, published,
    links: [{ raw, target_id, state }],
    offset, total_chars, truncated }
```

`max_chars` 默认 6000、上限 20000。超长笔记只回窗口。

无权 / 被 require_ai_index 挡掉：`NOT_FOUND`。

### get_backlinks

```
{ id: string }
→ { items: [{ id, title, snippet }] }
```

### ask_knowledge

```
{ question: string, notebook_id?: string }
→ {
    answer: string,
    citations: [{ note_id, title, notebook_id, path, version, updated_at,
                  excerpt, relevance_score?, citation_number,
                  current_version, version_matches_current }],
    source_version_changed: boolean,
    retrieval_metadata: { mode, hit_count, source_count, truncated }
  }
```

答案里的 `[#n]` 对应 `citation_number=n`。回答生成后会重新读取源版本；若引用的版本已变化或来源已进入回收站，逐条 `version_matches_current=false`，同时顶层 `source_version_changed=true`。

### create_note

```
{ notebook_id: string, folder_id?: string, title: string,
  body_md?: string, tags?: string[] }
→ { id, version }
```

执行层继续兼容旧客户端的 `content` 别名；新客户端只从工具 schema 看到 `body_md`。

### create_folder

```
{ notebook_id: string, parent_id?: string | null, title: string,
  client_request_id?: string }
→ { id, notebook_id, parent_id, title }
```

按钥匙范围与笔记本编辑权限校验；父目录必须在同一笔记本内，目录深度最多 8 层。支持 `client_request_id` 和 HTTP `Idempotency-Key`。

### update_note

```
{ id: string, expected_version: number, body_md?: string, title?: string }
→ { id, version }
```

缺 `expected_version`：`VALIDATION`。冲突：`CONFLICT_VERSION` + 当前 version。

### append_to_note

```
{ id: string, content: string, expected_version?: number }
→ { id, version }
```

内部读 version 再追加，冲突时乐观重试 2 次；传了 `expected_version` 则不重试。

### replace_in_note

```
{ id: string, expected_version: number, old: string, new: string, replace_all?: boolean }
→ { id, version, replacements }
```

只替换正文片段。`old` 找不到或出现多次（未 `replace_all`）→ `VALIDATION`。

### list_recent

```
{ since?: string, limit?: number, cursor?: string }   // 默认 20，上限 50
→ { items, notes: items, next_cursor, has_more }
```

### today

无参。`{ date, timezone, items, overdue, notes }`。条目形状同 `list_tasks` / `list_events`；`notes` 是今天改过的笔记，不含正文。

### list_attachments

```
{ note_id: string }
→ { attachments: [{ id, filename, mime, bytes, markdown }] }
```

### upload_image

```
{ note_id: string, filename: string, mime: "image/png"|"image/jpeg"|"image/webp"|"image/gif",
  data_base64: string }
→ { id, filename, mime, bytes, markdown }
```

只存附件，不改正文。兼容路径硬限制 512KB，超出返回 `PAYLOAD_TOO_LARGE`。大文件使用 `create_attachment_upload` 创建 15 分钟会话，按返回 headers 向 `/api/v1/mcp/uploads/:id` 原始二进制 PUT，再调用 `complete_attachment_upload`。上传会话仅保存凭证哈希；PUT/完成均核验 bytes、SHA-256、MIME 魔数和归属权限，过期暂存由 worker 清理。

### move_note / add_tags / trash_note

仅对应档位注册。`trash_note` 仅 `allow_delete`。`move_note` 与 `trash_note` 必须带 `expected_version`，更新时也以版本作为 SQL 条件；二者均支持 `dry_run` 预览。公开 `post_to_feed` 必须带 `confirm_public=true`，缺少时返回 `CONFIRMATION_REQUIRED`。

---

### list_tasks / list_events

```
list_tasks  { from?: string, to?: string, status?: 'open'|'done'|'all', cursor?: string,
              assignee?: 'me'|'any'|handle, include_inbox?: boolean, limit?: number }
→ { items: [{ id, title, due_at, occurrence_start, status, priority, all_day,
              recurring, source, link_state, source_note_id?, note_title?, url }] }

list_events { from?: string, to?: string, limit?: number, cursor?: string }
→ { items: [{ id, title, starts_at, ends_at, all_day, recurring, url, ... }] }
```

窗口默认「今天起 14 天」（当地日历日 00:00 起），单次上限 200 条，最长 400 天。
五个列表工具的 cursor 均为 HMAC 签名的短期不透明值，绑定工具、筛选条件和钥匙授权范围；无效返回 `INVALID_CURSOR`，15 分钟过期返回 `CURSOR_EXPIRED`。
`list_tasks` 默认只给 `open`，并额外带上收件箱里没期限的任务（`include_inbox`，默认 true）——问「我要做什么」的人不会希望漏掉没排期的那些。
重复条目按窗口展开，每个实例带 `occurrence_start`，写操作必须带回。
来源笔记不可见的条目直接不返回（不是 403），且钥匙的笔记本范围、`require_ai_index`、私密笔记本开关全部继承自笔记本身的判定。

### create_task / complete_task

```
create_task   { title: string, due_at?: string, all_day?: boolean,
                priority?: 0|1|2|3, note?: string }
→ { id, title, due_at, status, url }

complete_task { id: string, occurrence_start?: string, done?: boolean }
→ { id, status, note_written: boolean, detached: boolean, source_note_id? }
```

`create_task` 只能建 `source=mcp` 的独立任务，**不能写笔记正文**——否则一把只读钥匙能靠建任务绕道改正文。  
`complete_task` 命中 `source=note` 的条目时会回写正文，因此需要钥匙具备写档位；块锚丢失则返回 `note_written: false` 并把条目标 `detached`，不报错。

---

## 6. 客户端配置模板

设置页生成（secret 仅当时插入）：

```json
{
  "mcpServers": {
    "knowledge": {
      "url": "{PUBLIC_URL}/mcp",
      "headers": { "Authorization": "Bearer {SECRET}" }
    }
  }
}
```

Claude Desktop 若仍要 stdio：

```json
{
  "mcpServers": {
    "knowledge": {
      "command": "npx",
      "args": ["-y", "@knowledge/mcp-stdio", "{PUBLIC_URL}"],
      "env": { "KNOWLEDGE_TOKEN": "{SECRET}" }
    }
  }
}
```

包名实现时可改，**字段形态保持 url/headers 或 command/env**。
