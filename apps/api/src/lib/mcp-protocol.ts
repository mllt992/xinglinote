/** MCP 工具目录：schema、档位、注解、握手说明。挂载方按钥匙动态减清单。 */

export type ToolTier = "read" | "write" | "manage" | "delete" | "feed";

export type ToolAnnotations = {
  title: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type ToolDef = {
  description: string;
  tier: ToolTier;
  properties?: Record<string, unknown>;
  required?: string[];
  annotations: ToolAnnotations;
};

const UUID = { type: "string", format: "uuid" } as const;
// 这些字段都不是必填，省略就表示根目录。执行层继续接受旧客户端的 null；
// 对外不再发布 `type: ["string", "null"] + format: uuid`，部分 MCP 客户端会把它误生成为截断 JSON。
const OPTIONAL_ROOT_UUID = { type: "string", format: "uuid", description: "省略表示笔记本根目录；不要传空字符串" } as const;
const TAGS = { type: "array", items: { type: "string", minLength: 1, maxLength: 50 }, maxItems: 50 } as const;
const CLIENT_REQUEST_ID = { type: "string", format: "uuid", description: "同一次逻辑操作重试时保持不变；服务端保留首次成功结果 10 分钟" } as const;
const NOTE_TARGET_PROPS = {
  id: UUID,
  expected_version: { type: "integer", minimum: 1 },
  title: { type: "string", minLength: 1, maxLength: 200 },
} as const;
const EDIT_PROPS = { ...NOTE_TARGET_PROPS, body_md: { type: "string", description: "完整 Markdown 正文" } } as const;
const APPEND_PROPS = { ...NOTE_TARGET_PROPS, content: { type: "string" } } as const;

/**
 * create_note / update_note 对外统一叫 body_md；content 是早期 schema 用过的名字，
 * 仍在执行层兼容，避免已经缓存旧工具定义的客户端升级后突然失效。
 */
export function mcpNoteBody(input: { body_md?: string; content?: string }, fallback: string) {
  return input.body_md ?? input.content ?? fallback;
}

const read = (title: string, extra: Partial<ToolAnnotations> = {}): ToolAnnotations => ({
  title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, ...extra,
});
const write = (title: string, extra: Partial<ToolAnnotations> = {}): ToolAnnotations => ({
  title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, ...extra,
});

export const MCP_INSTRUCTIONS = [
  "这是星璃笔记的知识库 MCP。一把钥匙可以勾选多个工作区，权限不会超过持有人本人。",
  "先调 get_me，看 workspaces、rw、notebooks 和到期时间，再动手。",
  "找内容用 search_notes（默认 hybrid，默认 8 条摘要），不要用 list_folder 扫整库，也不要猜测 UUID。hybrid 连不上 Embedding 时会降级成关键词，不必当成整库挂了。",
  "读一篇用 get_note；默认最多回 2000 字，超长时 truncated=true，用 offset / max_chars 翻页；只要摘要可传 snippet_only=true。改正文必须先拿到 version，再传 expected_version。撞 CONFLICT_VERSION 必须用返回的 current_version 再 get_note，禁止自己 +1 猜下一版。",
  "create_note / update_note 用 body_md 传 Markdown 正文；append_to_note 仍用 content 追加。",
  "根目录场景省略 folder_id / parent_id（不要传空字符串）；整理目录可用 create_folder、rename_folder、move_folder，调整自定义顺序用 reorder_notes / reorder_folders。",
  "只改一段请用 replace_in_note，日记补一行用 append_to_note，不要整篇重写，也不要为了改一段把长文读完。",
  "问「今天做什么」用 today；看最近改动用 list_recent。",
  "小于 512KB 的配图可用 upload_image；更大的文件先调 create_attachment_upload，按返回信息直传二进制，再调 complete_attachment_upload。把 markdown 用 append_to_note 或 replace_in_note 插进正文。",
  "被关掉 ai_index 或不在范围内的笔记对读工具等于不存在（NOT_FOUND），不要靠报错探测。",
].join("\n");

export const TOOL_DEFS: Record<string, ToolDef> = {
  get_me: {
    tier: "read",
    description: "返回当前 MCP 钥匙的持有人、勾选的工作区、读写档、可见笔记本与到期时间。开始工作前先调一次。",
    annotations: read("当前钥匙"),
  },
  list_notebooks: {
    tier: "read",
    description: "列出这把钥匙范围内的笔记本。",
    properties: { limit: { type: "integer", minimum: 1, maximum: 200, default: 50 }, cursor: { type: "string", description: "上一页返回的不透明 cursor" } },
    annotations: read("笔记本列表"),
  },
  list_folder: {
    tier: "read",
    description: "列出某个笔记本或目录下的子目录与笔记；folder_id 省略表示根目录，不要传空字符串。不含正文，返回 sort_key 供排序工具使用。示例：{\"notebook_id\":\"...\"}。",
    properties: { notebook_id: UUID, folder_id: OPTIONAL_ROOT_UUID, limit: { type: "integer", minimum: 1, maximum: 200, default: 50 }, cursor: { type: "string", description: "上一页返回的不透明 cursor" } },
    required: ["notebook_id"],
    annotations: read("目录"),
  },
  create_folder: {
    tier: "write",
    description: "在笔记本根目录或指定父目录下新建文件夹。重试请带同一 client_request_id。",
    properties: {
      notebook_id: UUID,
      parent_id: OPTIONAL_ROOT_UUID,
      title: { type: "string", minLength: 1, maxLength: 100 },
      client_request_id: CLIENT_REQUEST_ID,
    },
    required: ["notebook_id", "title"],
    annotations: write("新建文件夹"),
  },
  rename_folder: {
    tier: "write",
    description: "重命名文件夹，不改变父目录和顺序。",
    properties: { id: UUID, title: { type: "string", minLength: 1, maxLength: 100 } },
    required: ["id", "title"],
    annotations: write("重命名文件夹", { idempotentHint: true }),
  },
  move_folder: {
    tier: "manage",
    description: "把文件夹及其子树移到同一笔记本内的另一个文件夹；parent_id 省略表示根目录。拒绝成环和超过 8 层。dry_run=true 可先预览。",
    properties: { id: UUID, parent_id: OPTIONAL_ROOT_UUID, dry_run: { type: "boolean", default: false, description: "仅预览影响，不修改数据" } },
    required: ["id"],
    annotations: write("移动文件夹", { idempotentHint: true }),
  },
  reorder_notes: {
    tier: "manage",
    description: "调整同一目录下笔记的自定义顺序。folder_id 省略表示根目录；note_ids 按目标顺序列出，可只传要互换的子集，未列出的条目保持原槽位。",
    properties: { notebook_id: UUID, folder_id: OPTIONAL_ROOT_UUID, note_ids: { type: "array", items: UUID, minItems: 1, maxItems: 2000 } },
    required: ["notebook_id", "note_ids"],
    annotations: write("调整笔记顺序", { idempotentHint: true }),
  },
  reorder_folders: {
    tier: "manage",
    description: "调整同一父目录下文件夹的自定义顺序。parent_id 省略表示根目录；folder_ids 按目标顺序列出，可只传要互换的子集，未列出的条目保持原槽位。",
    properties: { notebook_id: UUID, parent_id: OPTIONAL_ROOT_UUID, folder_ids: { type: "array", items: UUID, minItems: 1, maxItems: 2000 } },
    required: ["notebook_id", "folder_ids"],
    annotations: write("调整文件夹顺序", { idempotentHint: true }),
  },
  search_notes: {
    tier: "read",
    description: "检索笔记。mode=keyword 只做关键词；semantic 语义；hybrid（默认）两者融合。每条返回 note_id、路径、版本和短摘录（可用 max_chars 调上限，snippet_only=true 时不回摘录），再用 note_id 调 get_note 核验。默认 8 条。hybrid 在 Embedding 连不上时会降级成关键词，retrieval_metadata.degraded=true。",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 200 },
      notebook_id: UUID,
      workspace_id: UUID,
      tag: { type: "string" },
      mode: { type: "string", enum: ["keyword", "semantic", "hybrid"], default: "hybrid" },
      limit: { type: "integer", minimum: 1, maximum: 20, default: 8 },
      max_chars: { type: "integer", minimum: 40, maximum: 2000, default: 360, description: "单条摘录字数上限；snippet_only=true 时忽略" },
      snippet_only: { type: "boolean", default: false, description: "为 true 时只返回 note_id/路径/版本等元数据，不含摘录" },
    },
    required: ["query"],
    annotations: read("搜索笔记", { openWorldHint: true }),
  },
  get_note: {
    tier: "read",
    description: "按 ID 读取笔记的正文、路径、版本号、标签与双链。无权或未开 AI 索引时当作不存在。默认最多 2000 字，超长用 offset / max_chars 翻页；snippet_only=true 时只回约 360 字摘要。返回 truncated / total_chars。",
    properties: {
      id: UUID,
      offset: { type: "integer", minimum: 0, default: 0 },
      max_chars: { type: "integer", minimum: 200, maximum: 20000, default: 2000 },
      snippet_only: { type: "boolean", default: false, description: "为 true 时只回短摘要（约 360 字），仍含 version/path 以便溯源" },
    },
    required: ["id"],
    annotations: read("读笔记"),
  },
  get_backlinks: {
    tier: "read",
    description: "列出指向该笔记的反向链接，只含钥匙能读的来源。",
    properties: { id: UUID },
    required: ["id"],
    annotations: read("反向链接"),
  },
  ask_knowledge: {
    tier: "read",
    description: "基于知识库内容问答，答案中的 [#n] 对应 citations[].citation_number；引用含 note_id、路径、版本、短摘录及版本一致性标记。可用 max_context_chars 压上下文预算。不要用它代替 search_notes 做浏览。",
    properties: {
      question: { type: "string", minLength: 1, maxLength: 2000 },
      notebook_id: UUID,
      workspace_id: UUID,
      max_context_chars: { type: "integer", minimum: 400, maximum: 8000, default: 2200, description: "送进模型的片段总字数预算（含标题开销）" },
    },
    required: ["question"],
    annotations: read("知识问答", { openWorldHint: true }),
  },
  list_recent: {
    tier: "read",
    description: "按更新时间倒序列出最近改过的笔记，不含正文。",
    properties: {
      since: { type: "string", format: "date-time" },
      workspace_id: UUID,
      limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      cursor: { type: "string", description: "上一页返回的不透明 cursor" },
    },
    annotations: read("最近改动"),
  },
  today: {
    tier: "read",
    description: "今天的日程、逾期未完成任务、以及今天改过的笔记。问「我今天该做什么」时优先用这个。",
    properties: { workspace_id: UUID },
    annotations: read("今天"),
  },
  list_attachments: {
    tier: "read",
    description: "列出这篇笔记的附件（文件名、类型、大小和可插入正文的 markdown），不含文件本身。",
    properties: { note_id: UUID },
    required: ["note_id"],
    annotations: read("附件列表"),
  },
  upload_image: {
    tier: "write",
    description: "兼容小图上传，仅限 512KB。更大的图片请使用 create_attachment_upload + 二进制 PUT + complete_attachment_upload。只存文件，不改正文。",
    properties: {
      note_id: UUID,
      filename: { type: "string", minLength: 1, maxLength: 180 },
      mime: { type: "string", enum: ["image/png", "image/jpeg", "image/webp", "image/gif"] },
      data_base64: { type: "string", minLength: 1, maxLength: 699200, description: "不超过 512KB 图片的 base64，可带 data:image/…;base64, 前缀" },
      client_request_id: CLIENT_REQUEST_ID,
    },
    required: ["note_id", "filename", "mime", "data_base64"],
    annotations: write("上传图片"),
  },
  create_attachment_upload: {
    tier: "write",
    description: "创建短期二进制上传会话。返回 upload_url、method 和所需 headers；不要把上传凭证写入日志。",
    properties: {
      note_id: UUID,
      filename: { type: "string", minLength: 1, maxLength: 180 },
      mime: { type: "string", enum: ["image/png", "image/jpeg", "image/webp", "image/gif"] },
      bytes: { type: "integer", minimum: 1, maximum: 26214400 },
      sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      client_request_id: CLIENT_REQUEST_ID,
    },
    required: ["note_id","filename","mime","bytes","sha256"],
    annotations: write("创建附件上传"),
  },
  complete_attachment_upload: {
    tier: "write",
    description: "完成二进制上传，重新校验大小、SHA-256、文件类型和笔记权限后绑定附件。重复完成返回同一附件。",
    properties: { upload_id: UUID, client_request_id: CLIENT_REQUEST_ID },
    required: ["upload_id"],
    annotations: write("完成附件上传"),
  },
  list_tasks: {
    tier: "read",
    description: "列出任务，默认只看未完成的。时间是 ISO 8601 字符串。",
    properties: {
      from: { type: "string", format: "date-time" },
      to: { type: "string", format: "date-time" },
      status: { type: "string", enum: ["open", "done", "all"], default: "open" },
      assignee: { type: "string", maxLength: 40 },
      include_inbox: { type: "boolean", default: true },
      workspace_id: UUID,
      limit: { type: "integer", minimum: 1, maximum: 200, default: 200 },
      cursor: { type: "string", description: "上一页返回的不透明 cursor" },
    },
    annotations: read("任务列表"),
  },
  list_events: {
    tier: "read",
    description: "列出日历事件。时间是 ISO 8601 字符串。",
    properties: {
      from: { type: "string", format: "date-time" },
      to: { type: "string", format: "date-time" },
      status: { type: "string", enum: ["open", "done", "all"], default: "all" },
      assignee: { type: "string", maxLength: 40 },
      include_inbox: { type: "boolean", default: true },
      workspace_id: UUID,
      limit: { type: "integer", minimum: 1, maximum: 200, default: 200 },
      cursor: { type: "string", description: "上一页返回的不透明 cursor" },
    },
    annotations: read("日程列表"),
  },
  create_note: {
    tier: "write",
    description: "新建笔记。ai_index / published 跟随目标笔记本默认值。重试请带同一 client_request_id。",
    properties: {
      notebook_id: UUID,
      folder_id: OPTIONAL_ROOT_UUID,
      title: { type: "string", minLength: 1, maxLength: 200 },
      body_md: { type: "string", default: "", description: "完整 Markdown 正文" },
      tags: TAGS,
      client_request_id: CLIENT_REQUEST_ID,
    },
    required: ["notebook_id", "title"],
    annotations: write("新建笔记"),
  },
  update_note: {
    tier: "write",
    description: "覆盖笔记正文或标题。expected_version 必填，传 get_note 拿到的 version，版本不符会报 CONFLICT_VERSION。禁止自己 +1 猜下一版，必须用返回的 current_version 再 get_note。",
    properties: { ...EDIT_PROPS, dry_run: { type: "boolean", default: false, description: "仅预览影响，不修改数据" } },
    required: ["id", "expected_version"],
    annotations: write("覆盖笔记"),
  },
  append_to_note: {
    tier: "write",
    description: "在笔记末尾追加内容，不覆盖原文。适合日记。expected_version 可选；不传则冲突时自动重试两次。",
    properties: APPEND_PROPS,
    required: ["id", "content"],
    annotations: write("追加笔记"),
  },
  replace_in_note: {
    tier: "write",
    description: "只替换正文中的一段。old 必须能在正文里精确匹配；出现多次时要么补更长上下文，要么传 replace_all=true。expected_version 可选；不传则冲突时若 old 仍能唯一匹配会自动重试两次。",
    properties: {
      id: UUID,
      expected_version: { type: "integer", minimum: 1 },
      old: { type: "string", minLength: 1 },
      new: { type: "string" },
      replace_all: { type: "boolean", default: false },
    },
    required: ["id", "old", "new"],
    annotations: write("替换片段"),
  },
  create_task: {
    tier: "write",
    description: "新建独立任务；due_at 省略或传 null 进收集箱。不会改任何笔记正文。",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 200 },
      due_at: { type: ["string", "null"], format: "date-time" },
      all_day: { type: "boolean", default: false },
      priority: { type: "integer", minimum: 0, maximum: 3, default: 0 },
      note: { type: "string", maxLength: 2000, default: "" },
      workspace_id: UUID,
      client_request_id: CLIENT_REQUEST_ID,
    },
    required: ["title"],
    annotations: write("新建任务"),
  },
  complete_task: {
    tier: "write",
    description: "勾选或取消勾选任务；重复任务用 occurrence_start 指定是哪一次。来源是笔记的任务会回写正文。dry_run=true 可先预览。",
    properties: {
      id: UUID,
      done: { type: "boolean", default: true },
      occurrence_start: { type: "string", format: "date-time" },
      dry_run: { type: "boolean", default: false, description: "仅预览影响，不修改数据" },
    },
    required: ["id"],
    annotations: write("完成任务"),
  },
  move_note: {
    tier: "manage",
    description: "把笔记移动到另一个笔记本或目录。两端都要在钥匙范围内；必须传当前 expected_version。dry_run=true 可先预览。",
    properties: { id: UUID, expected_version: { type: "integer", minimum: 1 }, notebook_id: UUID, folder_id: OPTIONAL_ROOT_UUID, dry_run: { type: "boolean", default: false, description: "仅预览影响，不修改数据" } },
    required: ["id", "expected_version", "notebook_id"],
    annotations: write("移动笔记", { idempotentHint: true }),
  },
  add_tags: {
    tier: "manage",
    description: "给笔记追加标签，与原有标签合并去重。不升正文 version，避免正在编辑的页面 409。",
    properties: { id: UUID, tags: TAGS },
    required: ["id", "tags"],
    annotations: write("打标签", { idempotentHint: true }),
  },
  trash_note: {
    tier: "delete",
    description: "把笔记移入回收站（不是永久删除）。必须传当前 expected_version；dry_run=true 可先预览。",
    properties: { id: UUID, expected_version: { type: "integer", minimum: 1 }, dry_run: { type: "boolean", default: false, description: "仅预览影响，不修改数据" } },
    required: ["id", "expected_version"],
    annotations: { title: "回收笔记", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  trash_folder: {
    tier: "delete",
    description: "把文件夹、全部子文件夹及其中笔记移入回收站（不是永久删除）。dry_run=true 可先查看影响数量。",
    properties: { id: UUID, dry_run: { type: "boolean", default: false, description: "仅预览影响，不修改数据" } },
    required: ["id"],
    annotations: { title: "回收文件夹", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  post_to_feed: {
    tier: "feed",
    description: "发一条动态到工作区圈子或公开广场。公开发布必须额外传 confirm_public=true；dry_run=true 可先预览。body 是 Markdown，可带笔记回链。",
    properties: {
      body: { type: "string", minLength: 1, maxLength: 5000 },
      scope: { type: "string", enum: ["workspace", "public"], default: "workspace" },
      note_id: UUID,
      workspace_id: UUID,
      confirm_public: { type: "boolean", default: false, description: "scope=public 时必须显式为 true" },
      dry_run: { type: "boolean", default: false, description: "仅预览影响，不修改数据" },
      client_request_id: CLIENT_REQUEST_ID,
    },
    required: ["body"],
    annotations: write("发动态"),
  },
};

export type TokenCaps = {
  rw: string;
  allowDelete: boolean;
  feedPublic: boolean;
  feedWorkspace: boolean;
};

export function toolAllowed(t: TokenCaps, name: string) {
  const d = TOOL_DEFS[name];
  if (!d) return false;
  if (d.tier === "read") return true;
  if (d.tier === "write") return t.rw === "write" || t.rw === "manage";
  if (d.tier === "manage") return t.rw === "manage";
  if (d.tier === "delete") return t.rw === "manage" && t.allowDelete;
  return t.feedPublic || t.feedWorkspace;
}

export function isWriteTool(name: string) {
  const d = TOOL_DEFS[name];
  return !!d && d.tier !== "read";
}

export function toolsFor(t: TokenCaps) {
  return Object.entries(TOOL_DEFS)
    .filter(([name]) => toolAllowed(t, name))
    .map(([name, d]) => ({
      name,
      description: d.description,
      inputSchema: { type: "object" as const, properties: d.properties ?? {}, required: d.required ?? [] },
      annotations: d.annotations,
    }));
}
