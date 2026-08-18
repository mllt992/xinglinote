import { KB_EMAIL, KB_PASSWORD } from './creds.mjs';
const target = await fetch("http://127.0.0.1:9223/json/new?http://127.0.0.1:5174/login", { method: "PUT" }).then(r => r.json());
const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
};
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
await call("Runtime.enable");
await call("Page.enable");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 50; i++) {
  const r = await call("Runtime.evaluate", { expression: "document.querySelector('form') !== null", returnByValue: true });
  if (r.result.value) break;
  await sleep(100);
}
const submit = `(() => {
  const set = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const inputs = [...document.querySelectorAll('input')];
  set(inputs[0], ${JSON.stringify(KB_EMAIL)});
  set(inputs[1], ${JSON.stringify(KB_PASSWORD)});
  document.querySelector('button[type=submit]').click();
  return true;
})()`;
await call("Runtime.evaluate", { expression: submit, returnByValue: true });
let state;
for (let i = 0; i < 100; i++) {
  const r = await call("Runtime.evaluate", {
    expression: "({url: location.href, body: document.body.innerText, cookie: document.cookie})",
    returnByValue: true,
  });
  state = r.result.value;
  if (state.url.includes("/w/") && state.body.includes("笔记")) break;
  await sleep(100);
}
const ok = state?.url?.includes("/w/") && state?.body?.includes("笔记");
console.log(JSON.stringify({ ok, ...state }, null, 2));
ws.close();
if (!ok) process.exitCode = 1;
