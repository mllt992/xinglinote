import http from "node:http";

const files = new Map();

function xmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const s = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const x of req) chunks.push(x);
  const data = Buffer.concat(chunks);
  const u = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = decodeURIComponent(u.pathname);

  if (req.method === "PUT") {
    files.set(path, data);
    res.statusCode = 200;
    res.end();
    return;
  }
  if (req.method === "DELETE") {
    files.delete(path);
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method === "GET" && path === "/_files") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify([...files].map(([p, buf]) => ({ path: p, bytes: buf.length, head: buf.subarray(0, 6).toString() }))));
    return;
  }
  if (req.method === "GET" && u.searchParams.get("list-type") === "2") {
    const prefix = u.searchParams.get("prefix") ?? "";
    const bucket = path.replace(/\/+$/, "") || "/";
    const keys = [...files.keys()]
      .filter(k => k.startsWith(`${bucket}/`) || k === bucket)
      .map(k => k.slice(bucket.length).replace(/^\/+/, ""))
      .filter(k => !prefix || k.startsWith(prefix));
    res.setHeader("content-type", "application/xml");
    res.end(`<?xml version="1.0"?><ListBucketResult>${keys.map(k => `<Contents><Key>${xmlEscape(k)}</Key></Contents>`).join("")}</ListBucketResult>`);
    return;
  }
  if (req.method === "GET") {
    const body = files.get(path);
    if (!body) { res.statusCode = 404; res.end(); return; }
    res.end(body);
    return;
  }
  res.statusCode = 404;
  res.end();
});

s.listen(19094, "127.0.0.1", () => console.log("mock-s3-ready"));
