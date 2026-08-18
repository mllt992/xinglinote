// 直连知识库 MCP 端点的命令行封装，不需要 MCP 客户端。
// 用法：node scripts/kb-mcp.mjs <tool> '<json-args>'
//       node scripts/kb-mcp.mjs list          # 列出可用工具
// 环境变量：KB_BASE_URL（默认 http://127.0.0.1:12098）、KB_MCP_TOKEN
const base = process.env.KB_BASE_URL ?? "http://127.0.0.1:12098";
const token = process.env.KB_MCP_TOKEN;
if (!token) throw new Error("缺少 KB_MCP_TOKEN");

async function rpc(method, params) {
  const r = await fetch(`${base}/api/v1/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${j.error.code} ${j.error.message}`);
  return j.result;
}

const [tool, rawArgs] = process.argv.slice(2);
if (!tool || tool === "list") {
  const { tools } = await rpc("tools/list");
  console.log(tools.map(t => t.name).join("\n"));
} else {
  const out = await rpc("tools/call", { name: tool, arguments: rawArgs ? JSON.parse(rawArgs) : {} });
  console.log(JSON.stringify(out.structuredContent ?? out, null, 2));
}
