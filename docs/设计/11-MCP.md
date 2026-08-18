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
| workspace_id | **恰好一个** |
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

Viewer 只能建 `rw=read`。Editor+ 可 write。manage 建议 Editor+ 都能建给自己，但仍受本人 ACL 限制。  
`inherit`：范围随此人在本区未来 ACL 变化。  
`allowlist`：创建时校验每个 id 当时 `can_read`；之后某本丢失读权则该本自动失效（不必改表）。新本不会进入 allowlist。

状态：active → revoked（吊销或轮换旧钥匙）。过期不算改 status，判定时看时间。

---

## 3. 交互

### 3.1 设置 → MCP 钥匙

「新建」：选工作区、档位（只读/写作/管理）、模式 inherit 或勾选多个笔记本、过期、高级开关。提交后弹层显示明文 + 「复制 Cursor 配置」「复制 Claude Desktop 配置」「我已保存」。关弹层后不再给明文。

列表：名称、区、范围摘要、档、每日额度、最后使用、过期。**只列 active**；轮换掉的旧钥匙与吊销的钥匙不再占位，查历史用 `?includeRevoked=1`。
操作：编辑、轮换、吊销。

编辑：改档位、笔记本范围、过期、额度与三个高级开关，校验与新建同一套（不能超过本人 ACL，allow_delete 仅 manage）。
**不换明文**，客户端配置继续可用；**不能换绑工作区**，要换就新建一把。

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

### 3.3 审计页

Owner/Admin 看本区：时间、token 名、user、tool、target note、结果码。本人看自己的。保留 90 天。

---

## 4. 业务规则

1. 钥匙不能大于 user 在该 workspace 的 ACL。
2. 请求 workspace 与钥匙绑定不一致 → FORBIDDEN。
3. `allow_private_notebooks=false` 时，`visibility=private` 的本对这把钥匙隐形（即使 inherit 且人能看）。
4. `require_ai_index=true` 时 `can_ai_read` 必须成立才能 get/search/ask。`update` 已有篇：若钥匙要求 ai_index 而篇是 false，**仍允许写吗？** —— **不允许 get，允许 update/append 仅当 `can_edit` 且目标在范围内**，避免日记完全锁死无法被「按 id 补一行」；但 search/ask/get 仍不可见。若产品更硬：写也禁止。  
   **拍板：search/get/ask 遵守 require_ai_index；create 跟随本默认；update/append/move 只看 ACL+范围，不看 ai_index。** 这样「关掉 AI 读取」不会挡住人用 Agent 改一篇已知 id 的日记——若担心，用户不要把日记放进 allowlist。
5. `update_note` 必须 `expected_version`，禁止 force。
6. `delete` 默认无工具暴露；仅 `allow_delete` 时注册 `trash_note`（进回收站）。
7. 日写入字节按 UTC 日加总 body。未设上限则只记账不设卡；设了上限，超限 QUOTA。
8. 每把钥匙 60 次/分钟。超限 429。
9. 用户被移出工作区、封禁、注销、钥匙吊销：立即失败。缓存 TTL ≤ 30s，吊销走主动失效。
10. 动态工具仅当 feed_* 打开才注册，默认清单里没有。
11. 对外文档站、分享页不跑 MCP。

---

## 5. 算法

### 5.1 鉴权链（每次工具）

```
token = resolve Bearer
if missing/revoked/expired/banned user: UNAUTHENTICATED
if token.workspace != 请求涉及的 workspace: FORBIDDEN
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

`get_note` 对「存在但 ai_index 关或无权」返回 `NOT_FOUND`，避免 Agent 用 id 扫私密。  
例外：`update_note` 对无权 NOT_FOUND/FORBIDDEN 同 02；对仅 ai_index 关但 can_edit 且在范围内：允许（规则 4）。

### 5.2 工具

**`get_me`**  
出：user handle、workspace id/name、rw、notebook_mode、notebooks[{id,title}]（inherit 则列当前能读且过 private/ai 过滤的本）、expires_at。

**`list_notebooks`**  
出：过范围过滤的本。

**`list_folder(notebook_id, path?)`**  
出：子目录与笔记标题、id。不含正文。

**`search_notes(query, notebook_id?, tag?, mode=keyword|semantic|hybrid)`**  
limit≤20。出：id、title、path、snippet≤240。hybrid 调 10 的融合但不跑问答模型。

**`get_note(id)`**  
出：id、title、path、body_md、version、tags、ai_index、published、links[]。

**`get_backlinks(id)`**  
出：from id/title/snippet，仅 can_read 的 from。

**`ask_knowledge(question, notebook_id?)`**  
复用 10 的 5.2。出：answer、citations[{note_id,title,excerpt}]。

**`create_note(notebook_id, folder_id?, title, content, tags?)`**  
须 write。ai_index/published 跟本默认。出：id、version。

**`update_note(id, expected_version, content?, title?)`**  
缺 expected_version → VALIDATION。冲突 → CONFLICT_VERSION + 当前 version。

**`append_to_note(id, content)`**  
内部读 version 再 update 追加，乐观重试 2 次。

**`move_note(id, notebook_id, folder_id?)`**  
须 manage。两端都要在范围内且 can_edit。

**`add_tags(id, tags[])`**  
须 manage。

**`trash_note(id)`**  
仅 allow_delete。走 12。

### 5.3 配置生成

把 instance public URL + Bearer 填进模板。不把用户其他钥匙写进去。

---

## 6. 与其他功能的关联

| 方向 | 关系 |
|---|---|
| ← 02、03、04、05、10、12 | 全部复用，禁止 MCP 另写一套保存/ACL |
| → 审计、13 | 审计可备；secret 永不备 |
| ← 12 | 移出成员默认作废其本区钥匙 |
| → 09 | feed 工具默认不注册 |

发出：`McpTokenRevoked`。写操作另写 audit 表，不靠领域事件凑。
