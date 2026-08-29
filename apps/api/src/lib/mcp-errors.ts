import { fail } from "@kb/shared";

export type McpToolErrorData = {
  code: string;
  message: string;
  [field: string]: unknown;
};

/**
 * 旧客户端只展示 JSON-RPC message，新客户端会读取结构化字段；两边都给足版本，
 * 不能让调用方在并发写入后靠 `expected + 1` 猜下一版。
 */
export function versionConflict(
  expectedVersion: number,
  currentVersion: number,
  extra?: { updatedBy?: string; title?: string; bodyMd?: string },
) {
  return fail(
    "CONFLICT_VERSION",
    `版本冲突：expected_version=${expectedVersion}，current_version=${currentVersion}`,
    {
      version: String(currentVersion),
      expected_version: String(expectedVersion),
      current_version: String(currentVersion),
      ...(extra?.updatedBy ? { updatedBy: extra.updatedBy } : {}),
      ...(extra?.title !== undefined ? { title: extra.title } : {}),
      ...(extra?.bodyMd !== undefined ? { bodyMd: extra.bodyMd } : {}),
    },
  );
}

/** MCP 业务错误属于工具执行结果，不是 JSON-RPC 协议错误。 */
export function mcpToolErrorResult(data: McpToolErrorData) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
    isError: true as const,
  };
}
