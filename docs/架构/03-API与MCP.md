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
| GET | `/api/v1/meta` | 公开 | 实例名、是否零用户、开放注册/码、广场开否 |
| POST | `/api/v1/auth/register` | 公开 | email, password, handle, displayName, code? |
| POST | `/api/v1/auth/verify-email` | 公开 | token |
| POST | `/api/v1/auth/login` | 公开 | email, password |
| POST | `/api/v1/auth/logout` | 登录 | |
| POST | `/api/v1/auth/forgot` | 公开 | email |
| POST | `/api/v1/auth/reset` | 公开 | token, password |
| GET | `/api/v1/me` | 登录 | 资料、个人工作区 id、instanceRole、appearance、themeId、accent |
| GET | `/api/v1/themes` | 登录/公开 meta | 已安装主题列表 |
| POST | `/api/v1/themes/import` | 视策略 | zip |
| POST | `/api/v1/themes/:id/enable` | 登录 | 选用 |
| DELETE | `/api/v1/themes/:id` | 视策略 | 卸载非 builtin |
| PATCH | `/api/v1/me/appearance` | 登录 | appearance, themeId, accent |
| PATCH | `/api/v1/me` | 登录 | displayName, handle, bio, avatar |
| POST | `/api/v1/me/password` | 登录 | old, new |
| GET | `/api/v1/admin/settings` | 实例管理员 | |
| PATCH | `/api/v1/admin/settings` | 同上 | 注册策略、广场、限额 |
| POST | `/api/v1/admin/smtp/test` | 同上 | |
| CRUD | `/api/v1/admin/codes` | 同上 | 批量生成只在 POST 响应里给明文 |
| GET/POST | `/api/v1/admin/users` | 同上 | 封禁、解封、升/降管理员、启动注销 |

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
| POST | `.../folders` | |
| PATCH | `.../folders/:fid` | 改名/移动 |
| DELETE | `.../folders/:fid` | trash |
| POST | `/api/v1/notes` | notebookId, folderId, title? |
| GET/PATCH | `/api/v1/notes/:id` | PATCH: bodyMd, title, published, aiIndex, expectedVersion, force? |
| DELETE | `/api/v1/notes/:id` | trash |
| POST | `/api/v1/notes/:id/move` | |
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
| PATCH/DELETE | `/api/v1/shares/:id` | 改密续期 / 取消 |
| POST | `/api/v1/public/shares/:token/unlock` | password |
| GET | `/api/v1/public/shares/:token` | 解锁后的内容 JSON（页面也可 SSR） |
| POST | `/api/v1/notebooks/:id/site` | 发布/改配置/下线 |

### 2.5 评论、动态、AI、MCP、回收站、备份

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/v1/comments` | |
| POST | `/api/v1/comments/:id/moderate` | |
| GET/POST | `/api/v1/corrections` | |
| POST | `/api/v1/corrections/:id/review` | accept/reject |
| GET/POST | `/api/v1/posts` | scope, workspaceId |
| POST | `/api/v1/posts/:id/like` | |
| PUT/DELETE | `/api/v1/posts/:id/favorite` | 收藏 / 取消 |
| GET/POST | `/api/v1/posts/:id/comments` | 一层回复；登录直发，广场访客先审 |
| POST | `/api/v1/posts/:id/report` | `{ reason, note? }`；先交 AI |
| POST | `/api/v1/posts/:id/appeal` | `{ note? }`；仅 AI 下架后的作者 |
| POST | `/api/v1/posts/:id/promote` | 转正为笔记 |
| POST | `/api/v1/notes/:id/excerpt-to-post` | |
| GET | `/api/v1/moderation/queue` | state=review\|recheck\|approved\|rejected，q=正文，author=作者，kind，page |
| PATCH | `/api/v1/moderation/:id` | action=approve \| reject；待审和已处理都能改，note 为说明 |
| POST | `/api/v1/ai/write` | 写作，回 diff |
| POST | `/api/v1/ai/ask` | SSE 流 |
| GET/PATCH | `/api/v1/workspaces/:id/ai` | |
| CRUD | `/api/v1/mcp-tokens` | POST 响应含一次性 secret 与配置 JSON |
| POST | `/api/v1/mcp-tokens/:id/rotate` | |
| GET | `/api/v1/workspaces/:id/mcp-audit` | |
| GET | `/api/v1/workspaces/:id/trash` | |
| POST | `/api/v1/trash/:type/:id/restore` | |
| DELETE | `/api/v1/trash/:type/:id` | purge |
| CRUD | `/api/v1/backup-targets` | |
| POST | `/api/v1/backup-targets/:id/run` | |
| POST | `/api/v1/backup-jobs/:id/restore` | |
| GET | `/api/v1/notifications` | |
| POST | `/api/v1/notifications/read` | |

导入导出：`POST /api/v1/import`（job）、`GET /api/v1/export?notebookId=`（job + 下载 token）。

### 2.6 日历与任务

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
- 初始化后 `tools/list` 按钥匙 rw/feed/delete **动态减工具**，不要列出再 403（减少 Agent 胡调）。
- 错误：MCP `isError` + 正文 `{ code, message }`，code 同 HTTP。

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

审计写失败**不回滚、也不影响本次调用的返回值**：笔记已经落库了还回一个错，会自动重试的
Agent 就会照着错误再建一遍，于是出现重复笔记。审计断了只在进程日志里喊一声。

---

## 5. 工具 JSON Schema（稳定合同）

名称与参数一期冻结，改名走新工具旧工具并存至少一个小版本。

### get_me

无参。返回用户、工作区、rw、notebookMode、notebooks[]、expiresAt。

### list_notebooks

无参。`{ notebooks: [{ id, title, slug, visibility }] }`

### list_folder

```
{ notebook_id: string, folder_id?: string }
→ { folders: [{id,title}], notes: [{id,title}] }
```

### search_notes

```
{ query: string, notebook_id?: string, tag?: string,
  mode?: "keyword"|"semantic"|"hybrid" }
→ { hits: [{ id, title, path, snippet }] }   // ≤20，snippet≤240
```

### get_note

```
{ id: string }
→ { id, title, path, body_md, version, tags, ai_index, published,
    links: [{ raw, target_id, state }] }
```

无权 / 被 require_ai_index 挡掉：`NOT_FOUND`。

### get_backlinks

```
{ id: string }
→ { items: [{ id, title, snippet }] }
```

### ask_knowledge

```
{ question: string, notebook_id?: string }
→ { answer: string, citations: [{ note_id, title, excerpt }] }
```

### create_note

```
{ notebook_id: string, folder_id?: string, title: string,
  content: string, tags?: string[] }
→ { id, version }
```

### update_note

```
{ id: string, expected_version: number, content?: string, title?: string }
→ { id, version }
```

缺 `expected_version`：`VALIDATION`。冲突：`CONFLICT_VERSION` + 当前 version。

### append_to_note

```
{ id: string, content: string }
→ { id, version }
```

### move_note / add_tags / trash_note

仅对应档位注册。`trash_note` 仅 `allow_delete`。

---

### list_tasks / list_events

```
list_tasks  { from?: string, to?: string, status?: 'open'|'done'|'all',
              assignee?: 'me'|'any'|handle, include_inbox?: boolean, limit?: number }
→ { items: [{ id, title, due_at, occurrence_start, status, priority, all_day,
              recurring, source, link_state, source_note_id?, note_title?, url }] }

list_events { from?: string, to?: string, limit?: number }
→ { items: [{ id, title, starts_at, ends_at, all_day, recurring, url, ... }] }
```

窗口默认「今天起 14 天」（当地日历日 00:00 起），单次上限 200 条，最长 400 天。
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
