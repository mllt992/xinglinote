# 02 工作区、成员与 ACL

## 1. 范围

管：工作区创建/删除/转让、个人工作区约束、角色、笔记本可见性、指定成员、邀请已有用户、权限函数。  
不管：笔记树本身（03）、分享对外通道（07）、MCP 减权（11，但必须调用本文函数）。

---

## 2. 对象与状态机

### 2.1 Workspace

| 字段 | 规则 |
|---|---|
| id / slug / name | slug 实例内唯一 |
| kind | `personal` / `normal` |
| owner_id | 必须是成员且角色 Owner |
| frozen | 只读冻结（封禁唯一 Owner 时，见 12） |
| feed_enabled | 圈子动态，默认开 |
| allow_member_invite | 默认仅 Admin/Owner 可发邀请 |
| created_at | |

个人工作区：`kind=personal`，与用户 1:1，不可删除、不可邀请、不可转让、不可改 kind。可改名（默认「{显示名}的库」）。

普通工作区：用户创建（若实例允许），可删、可邀请、可转让。删除是危险操作：本区笔记本、回收站、圈子、文档站配置一并进入「工作区销毁」而不是笔记回收站。须输入工作区名确认。

### 2.2 Membership

`workspace_id + user_id` 唯一。角色：`owner` / `admin` / `editor` / `viewer`。  
一个工作区必须恰好 1 个 Owner（转让时先加后改，同一事务）。

### 2.3 Notebook.visibility

| 值 | 读 | 写 |
|---|---|---|
| `open` | 全体成员按工作区角色 | Editor+ 可写；Viewer 只读 |
| `private` | 仅 `created_by` | 仅创建者 |
| `restricted` | `NotebookMember` 白名单 | 白名单里 role=edit 者 |

`NotebookMember`：user_id + role `edit`/`view`。创建者隐式 edit，不必占行。

Admin/Owner **不能**因角色读 `private` 本。紧急接管见 12，不在日常 ACL。

### 2.4 Invite

| 字段 | 规则 |
|---|---|
| token | 高熵，哈希存储 |
| workspace_id / role | role 不能是 owner |
| expires_at | 默认 7 天 |
| max_uses | 默认不限，可改成 1 |
| created_by | |
| status | active / revoked / expired |

也可「按邮箱/handle 直接添加」：对方已是用户则立刻成成员；不是则拒绝，提示改用注册码。

---

## 3. 交互

### 3.1 创建普通工作区

设置里「新建工作区」：名称、slug 预览。创建者成为 Owner，自带一个「收件箱」笔记本，`visibility=open`，`default_ai_index=true`。

个人工作区创建时预置：「笔记」（open + ai 开）。不预置关 AI 的日记本（默认允许 AI 读；用户要挡再自己建）。

### 3.2 成员页

列表：头像、显示名、handle、角色、加入时间。  
Owner/Admin：改角色、移出、复制邀请链接、按 handle 添加。  
不能把最后一个 Owner 改掉。不能移出自己除非已不是唯一 Owner。

个人工作区：成员页只显示自己，邀请按钮禁用，文案「个人工作区不能加入其他人。请新建家庭/项目工作区。」

### 3.3 笔记本权限

笔记本设置：可见性单选。选 `restricted` 出现成员多选 + 每人本内角色。  
从 `open` 改成 `private`：二次确认「其他成员将立即失去访问」。  
改 ACL 发 `NotebookAclChanged`。

### 3.4 邀请链接

已登录用户打开 `/invite/{token}`：展示工作区名与将获角色，确认加入。已是成员则直接跳进工作区。  
未登录：先登录/注册，带回 `redirect`。

---

## 4. 业务规则

1. 用户可加入的工作区数量一期不硬限；创建普通工作区受 `allow_user_create_workspace` 限制，实例管理员始终可建。
2. Viewer 不能创建笔记本、不能建分享、不能发圈子、不能开 MCP 写档。
3. Editor 可在 **自己有编辑权的笔记本** 里建目录/笔记/单篇与目录分享。
4. 只有 Admin/Owner 可：建笔记本、改他人笔记本可见性（`private` 本除外）、当场发布 / 下线整本文档站、审别人的发布申请、看本区全部分享、看全区回收站、配工作区备份与工作区 AI Key。对本有编辑权的 Editor 可**申请**发布文档站，通过前对外仍 404。
5. `private` 本的创建者离开工作区：本随人迁回个人工作区（见 12），不留给 Admin。
6. 工作区 `frozen=true`：所有写操作失败，读仍走原 ACL。
7. slug 修改后旧 slug 30 天 301 到新 slug（文档站 URL 会变，分享链接因 token 不变）。
8. 跨工作区只通过「同一用户的多个 membership」发生，不存在工作区之间的信任关系。

---

## 5. 算法

### 5.1 `workspace_role(user, workspace)`

```
if no membership: none
return membership.role
```

### 5.2 `can_read_note(actor, note)`

```
if actor is guest: return false          # 对外走分享/文档站，不走本函数
if note.trashed: return actor 能看该回收站条目（见 12）
ws = note.workspace
if workspace_role(actor, ws) is none: return false
nb = note.notebook
if nb.visibility == private:
    return actor.id == nb.created_by
if nb.visibility == restricted:
    return actor.id == nb.created_by OR actor in notebook_members
if nb.visibility == open:
    return true   # 已确认是成员
```

### 5.3 `can_edit_note(actor, note)`

```
if not can_read_note: return false
if ws.frozen: return false
role = workspace_role
if role in (viewer): return false
if nb.visibility == private:
    return actor.id == nb.created_by
if nb.visibility == restricted:
    return notebook_member.role == edit OR actor.id == created_by
if nb.visibility == open:
    return role in (owner, admin, editor)
```

Admin 对 `open` 本可写；对 `private` 本不可写不可读。

### 5.4 `can_create_share(actor, target)`

```
target 是笔记、目录或笔记本:
    return can_edit_note(actor, 该树所属笔记/目录/笔记本所在本的任意代表元)
    更精确：对该 notebook 有编辑权
整本当场发布 / 下线文档站:
    return role in (admin, owner) AND notebook 不是别人的 private
申请发布文档站:
    return can_create_share(actor, notebook) AND role 不是 admin/owner
    （管理员不必申请，直接发布）
```

### 5.5 权限缓存

membership + notebook_member 变更时失效该 user+workspace 的缓存。MCP 每次写仍要实时查（或缓存 TTL ≤ 30s）。禁止把 ACL 快照长期塞进 JWT。

---

## 6. 与其他功能的关联

| 方向 | 关系 |
|---|---|
| ← 01 | 注册成功建个人区；注册码 bind 调 `MemberAdded` |
| → 03 | 树操作前先 `can_edit` |
| → 04 | 无权目标渲染 `EXISTS_INVISIBLE`，不得用 404 暴露「是否存在」给已登录但无权限的同站用户——已登录用 403 专用态；对外访客用 404 |
| → 05 | 搜索候选必须先过滤 `can_read` |
| → 07 | 分享创建走 `can_create_share`；打开分享不走本 ACL |
| → 10 | `can_ai_read` = `can_read` ∧ `ai_index` ∧ 钥匙约束 |
| → 11 | 钥匙不能大于本文结果 |
| → 12 | 移出成员、冻结、销毁工作区 |
| → 09 | 圈子可见 = 有 membership |

发出：`WorkspaceCreated`、`WorkspaceMemberAdded`、`WorkspaceMemberRemoved`、`NotebookAclChanged`、`WorkspaceFrozen`。
