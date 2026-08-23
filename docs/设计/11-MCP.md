# 11 MCP

## 1. 范围

管：钥匙模型、创建/轮换/吊销、开源客户端配置、工具清单与参数、鉴权链、审计、限流。  
不管：模型推理（10）、传输层具体框架选型（架构文档），但必须是标准 MCP，HTTP+Header 或 SSE，不绑 Cursor 私有协议。

---

## 2. 对象与状态机

### 2.1 McpToken

| 字段 | 说明 |
|---|---|
| id | 公开，可进审计 |
| secret_hash | 明文 `kbk_{id前8}_{高熵}` 只创建/轮换时显示一次 |
| name | 用户起名 |
| user_id | 主体，不可改为别人 |
| workspace_id | 主工作区，等于 `workspace_ids[0]`，给旧查询 / FK 用 |
| workspace_ids[] | **至少一个**。只能是持有人当时的成员区 |
| notebook_mode | `inherit` / `allowlist` |
| notebook_ids[] | allowlist 时 |
| rw | `read` / `write` / `manage` |
| allow_delete | 默认 false，仅 manage 可勾 |
| require_ai_index | 默认 true |
| allow_private_notebooks | 默认 false |
| feed_public / feed_workspace | 默认 false |
| expires_at | 可空 |
| daily_write_bytes | **默认空 = 不限**。想给跑飞的 Agent 兜底时才填一个每日上限 |
| status | `active` / `revoked` |
| last_used_at | |
| created_at | |

Viewer 只能建 `rw=read`。只要勾选的区里有一个是 Viewer，这把钥匙就只能是只读。Editor+ 可 write。manage 建议 Editor+ 都能建给自己，但仍受本人在**每个**勾选区的 ACL 限制。  
`inherit`：范围随此人在各勾选区未来 ACL 变化。  
`allowlist`：创建时校验每个 id 当时 `can_read`，且该本必须属于某个勾选区；之后某本丢失读权则该本自动失效（不必改表）。新本不会进入 allowlist。

状态：active → revoked（吊销或轮换旧钥匙）。过期不算改 status，判定时看时间。

---

## 3. 交互

### 3.1 设置 → MCP 钥匙

「新建」：勾选一个或多个工作区、档位（只读/写作/管理）、模式 inherit 或勾选多个笔记本、过期、高级开关。提交后弹层显示明文 + 「复制 Cursor 配置」「复制 Claude Desktop 配置」「我已保存」。关弹层后不再给明文。

列表：名称、区（多个用顿号）、范围摘要、档、每日额度、最后使用、过期。**只列 active**；轮换掉的旧钥匙与吊销的钥匙不再占位，查历史用 `?includeRevoked=1`。
操作：编辑、轮换、吊销。

列表下方「最近 MCP 调用」：时间、钥匙名、工具（或 JSON-RPC 方法名）、成败。失败时必须展示 `details.code` 与 `details.message`，不要只给一个 `error` 徽章——否则用户无法排查。握手 / 保活（`initialize` / `ping` / `tools/list` / `notifications/*`）成功不占这条列表。

编辑：改工作区勾选、档位、笔记本范围、过期、额度与三个高级开关，校验与新建同一套（不能超过本人 ACL，allow_delete 仅 manage）。
**不换明文**，客户端配置继续可用。工作区可以加减，至少留一个。

轮换：旧 secret 立刻 401；新 secret 只显示一次，权限克隆。

### 3.2 开源配置形态

```json
{
  "mcpServers": {
    "knowledge": {
      "url": "https://{instance}/mcp",
      "headers": { "Authorization": "Bearer kbk_xxxxxxxx_..." }
    }
  }
}
```

文档同时给 stdio 桥接示例（本地小进程转发），方便只支持 stdio 的客户端。协议工具名稳定，见第 5 节。

### 3.3 OAuth 接入（给云端客户端）

Claude.ai 连接器、ChatGPT 的 Create app 这类**云端**客户端不给填自定义请求头，只认
「一个公网 HTTPS 地址 + OAuth」。所以除了手工贴明文，实例同时是一个授权服务器：

| 端点 | 规范 |
|---|---|
| `/.well-known/oauth-protected-resource` | RFC 9728 受保护资源元数据 |
| `/.well-known/oauth-authorization-server` | RFC 8414 授权服务器元数据 |
| `POST /api/v1/oauth/register` | RFC 7591 动态客户端注册 |
| `GET /api/v1/oauth/authorize` | 授权码，**强制 PKCE S256** |
| `POST /api/v1/oauth/token` | 换 access token |

发现链路：客户端不带 token 打 `/api/v1/mcp` → 401 且带
`WWW-Authenticate: Bearer resource_metadata="…"` → 顺着元数据找到授权服务器 → 注册 →
跳授权 → 落到 `/oauth/consent` 同意页。

**关键取舍：授权通过后不发 JWT。** 同意页把工作区（可多选）、档位、笔记本范围、三个高级开关、
有效期勾定，换 token 时照常在 `mcp_tokens` 里落一行，access token 就是那把
`kbk_` 明文。好处是第 4 节业务规则一条都不用改——鉴权、范围、额度、审计、
**吊销即刻生效**全部复用既有那套；自证明的 JWT 恰恰做不到第 9 条。

代价是不发 refresh token：access token 要么永不过期，要么按同意页选的有效期到点作废，
到期后客户端重走一次授权。对自托管场景这个取舍是划算的。

同意页给出去的权限**不会超过本人在每个勾选工作区的权限**，校验和手工建钥匙共用一套：
只要有一个勾选区是 Viewer 就只能授权只读，`allow_delete` 只有 manage 档位能开，allowlist 里的每个笔记本都要
逐个过 `notebookAccess` 且属于某个勾选区。授权码单次有效、10 分钟过期；被重放时连带吊销它换出去的钥匙。

OAuth 签发的钥匙在设置页和手工建的并排显示（`source='oauth'`，记着 `client_id`），
随时可吊销。

### 3.4 审计页

Owner/Admin 看本区：时间、token 名、user、tool、target note、结果码、失败原因（`details.message`）。本人看自己的。保留 90 天。  
接口 `GET /api/v1/workspaces/:id/mcp-audit`，可按 `tokenId` / `tool` / `result` 筛；工作区总审计页同样能按「仅 MCP」过滤。失败行的徽章用业务码（`VALIDATION` / `FORBIDDEN` / `QUOTA`…），旁边写人话原因。

---

## 4. 业务规则

1. 钥匙不能大于 user 在**每个**勾选 workspace 的 ACL。
2. 请求涉及的 workspace 不在钥匙的 `workspace_ids` 里（或人已不是该区成员）→ FORBIDDEN。跨区读工具默认搜全部勾选区；写到「某个区」的工具（`create_task` / `post_to_feed`）在绑了多个区时必须带 `workspace_id`。
3. `allow_private_notebooks=false` 时，`visibility=private` 的本对这把钥匙隐形（即使 inherit 且人能看）。
4. `require_ai_index=true` 时 `can_ai_read` 必须成立才能 get/search/ask。`update` 已有篇：若钥匙要求 ai_index 而篇是 false，**仍允许写吗？** —— **不允许 get，允许 update/append 仅当 `can_edit` 且目标在范围内**，避免日记完全锁死无法被「按 id 补一行」；但 search/ask/get 仍不可见。若产品更硬：写也禁止。  
   **拍板：search/get/ask 遵守 require_ai_index；create 跟随本默认；update/append/move 只看 ACL+范围，不看 ai_index。** 这样「关掉 AI 读取」不会挡住人用 Agent 改一篇已知 id 的日记——若担心，用户不要把日记放进 allowlist。
5. `update_note` 必须 `expected_version`，禁止 force。
6. `delete` 默认无工具暴露；仅 `allow_delete` 时注册 `trash_note`（进回收站）。
7. 日写入字节按 UTC 日加总 body。未设上限则只记账不设卡；设了上限，超限 QUOTA。
8. 每把钥匙 60 次/分钟。超限 429。
9. 用户被移出某个勾选区：从这把钥匙的 `workspace_ids` 里拿掉该区（白名单里属于该区的本一并拿掉）；一个都不剩则整把吊销。封禁、注销、钥匙吊销：立即失败。缓存 TTL ≤ 30s，吊销走主动失效。
10. 动态工具仅当 feed_* 打开才注册，默认清单里没有。`tools/list` 必须按钥匙 rw / `allow_delete` / feed 减工具，不要列出再 403。
11. 对外文档站、分享页不跑 MCP。
12. 创建类工具公开可选 UUID 参数 `client_request_id`，所有写工具也认 HTTP 头 `Idempotency-Key`。幂等作用域为「钥匙 + 工具名 + 键」，数据库保留首次成功结果 10 分钟：相同参数重试原样返回，参数不同返回 `IDEMPOTENCY_KEY_REUSED`；并发相同请求等待首次结果，不重复落库。
13. `last_used_at` 最多 30 秒写一次，避免每次工具调用都抢钥匙行。

---

## 5. 算法

### 5.1 鉴权链（每次工具）

```
token = resolve Bearer
if missing/revoked/expired/banned user: UNAUTHENTICATED
live = token.workspace_ids ∩ 此人当前成员区
if live 为空: FORBIDDEN
if 请求涉及的 workspace 不在 live: FORBIDDEN
actor = token.user
if tool 是写且 rw==read: FORBIDDEN
if tool 是 move/tag 且 rw not manage: FORBIDDEN
if tool 是 trash 且 not allow_delete: FORBIDDEN

target notes:
  if notebook_mode==allowlist and note.notebook not in list: FORBIDDEN
  if not allow_private and notebook.visibility==private: FORBIDDEN
  if tool in (get,search,ask) and require_ai_index and not note.ai_index: 当作不存在
  if not can_read/can_edit as needed: FORBIDDEN 或 NOT_FOUND（search 省略）

执行业务（复用 03/04/05/10）
写审计
更新 last_used_at、日写入
```

读工具（`get_note` / `get_backlinks` / `search_notes` / `ask_knowledge` / `list_recent`）对「存在但 ai_index 关、不在范围、或无权」一律 `NOT_FOUND`（search / list_recent 则省略），避免 Agent 用 id 扫私密。  
例外：`update_note` / `append_to_note` / `replace_in_note` 对无权 NOT_FOUND/FORBIDDEN 同 02；对仅 ai_index 关但 can_edit 且在范围内：允许（规则 4）。

握手：`initialize` 必须带 `instructions`（先 `get_me`、搜不要扫库、改正文先拿 version）。每个工具带 MCP 注解：`readOnlyHint` / `destructiveHint` / `idempotentHint`。

### 5.2 工具

**`get_me`**  
出：user handle、workspace（第一个，兼容旧客户端）、workspaces[{id,name}]、rw、notebook_mode、notebooks[{id,title,slug,visibility,workspace_id}]（inherit 则列当前能读且过 private 过滤的本）、expires_at、require_ai_index、allow_private_notebooks、allow_delete、image_max_bytes（实例当前的 MCP 单张图上限）。

**`list_notebooks(limit?, cursor?)`**
出：过范围过滤的本，按 `title ASC, id ASC` 稳定排序。

**`list_folder(notebook_id, folder_id?, limit?, cursor?)`**
出：子目录与笔记标题、id。不含正文。

**`search_notes(query, notebook_id?, workspace_id?, tag?, mode=keyword|semantic|hybrid, limit?)`**  
limit≤20，**默认 8**（不要一上来塞 20 条摘要）。出：`{ hits: [{ id, title, path, snippet }] }`，snippet≤240。默认搜全部勾选区；传了 `workspace_id` 只搜那一区。keyword 走转义后的 ILIKE；semantic / hybrid 复用 10 的 `retrieve()`，但仍要过钥匙范围，不得绕开 `require_ai_index`。查询里的 `%` `_` 当字面量，不当通配符。

**`get_note(id, offset?, max_chars?)`**  
出：id、title、path（笔记本 → 目录 → 标题）、body_md、version、tags、ai_index、published、links[{raw,target_id,state}]、`offset`、`total_chars`、`truncated`。  
`max_chars` 默认 **6000**、上限 20000；`offset` 默认 0。超长笔记只回窗口，`truncated=true` 时用 `offset += 本次 body_md 长度` 再读。改正文仍靠 `version` + `replace_in_note` / `append_to_note`，不要为了改一段把整篇读进上下文。

**`get_backlinks(id)`**  
出：from id/title/snippet，仅 can_read 的 from。

**`ask_knowledge(question, notebook_id?, workspace_id?)`**  
复用 10 的 5.2。多区时默认跨勾选区检索再答；传了 `notebook_id` / `workspace_id` 则收窄。出：answer、citations[{note_id,title,excerpt}]。

**`create_note(notebook_id, folder_id?, title, content, tags?)`**  
须 write。ai_index/published 跟本默认。出：id、version。

**`update_note(id, expected_version, content?, title?)`**  
缺 expected_version → VALIDATION。冲突 → CONFLICT_VERSION + 当前 version。

**`append_to_note(id, content)`**  
内部读 version 再 update 追加，乐观重试 2 次。传了 `expected_version` 则不重试，冲突直接 `CONFLICT_VERSION`。

**`replace_in_note(id, expected_version, old, new, replace_all?)`**  
须 write。只替换一段正文，避免 Agent 整篇重写把后半截吃掉。`old` 找不到 → VALIDATION；出现多次且未 `replace_all` → VALIDATION，让调用方补更长上下文。

**`list_recent(since?, limit?, cursor?)`**
读档位。按 `updated_at` 倒序，默认 20、上限 50。只回 id / title / path / version / updated_at，不回正文。

**`today`**  
读档位。复用日历「今天」：今日条目、逾期未完成、今天改过的笔记（仍过钥匙范围）。给「我今天该干什么」一次拿齐。

**`list_attachments(note_id)`**  
读档位。列出这篇的附件：id、filename、mime、bytes、markdown。不回文件字节。

**`upload_image(note_id, filename, mime, data_base64)`**  
须 write。只收 png / jpeg / webp / gif，过魔数。单张不超过实例设置 `mcp_image_max_bytes`（默认 5MB，管理员可改，硬顶 25MB）。计入钥匙日写入与用户存储。  
**只存附件，不改正文。** 返回 `{ id, filename, mime, bytes, markdown }`，Agent 再用 `append_to_note` / `replace_in_note` 把 `markdown` 插到该放的位置。禁止去抓外链当图。

**`move_note(id, expected_version, notebook_id, folder_id?, dry_run?)`**
须 manage。两端都要在范围内且 can_edit；版本不符返回 `CONFLICT_VERSION`。`dry_run=true` 只返回来源、目标与执行所需版本。

**`add_tags(id, tags[])`**  
须 manage。

**`trash_note(id, expected_version, dry_run?)`**
仅 allow_delete。走 12。版本不符不产生副作用；`dry_run=true` 只返回将进入回收站的笔记及当前位置。

**`post_to_feed(body, scope?, confirm_public?, dry_run?)`**
`scope=public` 的实际发布必须显式传 `confirm_public=true`，否则返回 `CONFIRMATION_REQUIRED`；`dry_run=true` 不发布并返回范围、正文摘要和所需确认参数。

**`list_tasks(from?, to?, status?, assignee?, include_inbox?, limit?, cursor?)`** / **`list_events(from?, to?, limit?, cursor?)`**
读档位。窗口默认「今天起 14 天」，上限 200 条、最长 400 天。重复条目按窗口展开，每个实例带 `occurrence_start`。
`source=note` 的条目**完全继承来源笔记的判定**：钥匙的笔记本范围、`require_ai_index`、私密笔记本开关一并适用，不可见的直接不返回。
`list_tasks` 默认只给 `open`，并带上收件箱里没期限的任务。

上述五个列表工具统一返回 `{ items, next_cursor, has_more }`；兼容字段 `notebooks`、`folders`、`notes` 仍对应当前页。cursor 是服务端签名的不透明字符串，有效期 15 分钟，绑定工具、筛选条件、工作区与钥匙范围；篡改或跨查询复用返回 `INVALID_CURSOR`，过期返回 `CURSOR_EXPIRED`。

**`create_task(title, due_at?, all_day?, priority?, note?, workspace_id?)`**  
须 write。只能建 `source=mcp` 的独立任务，**不能写笔记正文**——否则一把「只读笔记」的钥匙能靠建任务绕道改正文。绑了多个区时 `workspace_id` 必填。

**`complete_task(id, occurrence_start?, done?)`**  
须 write。命中 `source=note` 的条目会回写正文 `- [x]`，因此额外要求对那篇笔记 `can_edit`（等于一次带审计的正文修改，走 16 §4.3 的版本合并）。
块锚丢失时返回 `note_written:false` 并把条目标 `detached`，不报错、不静默删条目。

### 5.3 配置生成

把 instance public URL + Bearer 填进模板。不把用户其他钥匙写进去。

---

## 6. 与其他功能的关联

| 方向 | 关系 |
|---|---|
| ← 02、03、04、05、10、12 | 全部复用，禁止 MCP 另写一套保存/ACL |
| → 审计、13 | 审计可备；secret 永不备 |
| ← 12 | 移出成员默认从钥匙里拿掉本区；一个区都不剩则整把作废 |
| → 09 | feed 工具默认不注册 |
| ← 16 | 日历四工具复用同一把钥匙的工作区与笔记本范围；`complete_task` 的回写走 16 §5.3 |

发出：`McpTokenRevoked`。写操作另写 audit 表，不靠领域事件凑。
