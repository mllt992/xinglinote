import http from "node:http";

const files = new Map();

const s = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const x of req) chunks.push(x);
  const data = Buffer.concat(chunks);
  const path = decodeURIComponent((req.url ?? "/").split("?")[0]);

  if (req.method === "PUT") {
    files.set(path, data);
    res.statusCode = 201;
    res.end();
    return;
  }
  if (req.method === "DELETE") {
    files.delete(path);
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method === "MKCOL") {
    res.statusCode = 201;
    res.end();
    return;
  }
  if (req.method === "PROPFIND") {
    const hrefs = [...files.keys()].filter(k => k.startsWith(path === "/" ? "/" : path.replace(/\/+$/, "")));
    res.statusCode = 207;
    res.setHeader("content-type", "application/xml");
    res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${hrefs.map(h => `<d:response><d:href>${h}</d:href></d:response>`).join("")}</d:multistatus>`);
    return;
  }
  if (req.method === "GET" && path === "/_files") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify([...files].map(([p, buf]) => ({ path: p, bytes: buf.length, head: buf.subarray(0, 6).toString() }))));
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

s.listen(19092, "127.0.0.1", () => console.log("mock-webdav-ready"));
