# 存到星璃（Chrome / Edge）

1. 在项目根目录运行 `pnpm --filter @kb/web build`，或单独运行 `node scripts/build-clipper.mjs`。
2. 从星璃「剪藏」页下载 `xingli-clipper.zip` 并解压；也可直接使用 `extensions/clipper/dist`。
3. Chrome `chrome://extensions` / Edge `edge://extensions` 中打开开发者模式，加载已解压的目录。此版本未发布到扩展商店。
4. 打开文章，点击扩展，填写自己实例的根地址并点击剪藏。在星璃确认目标工作区、笔记本、目录和图片，点击保存。受限文章可先选中已可见片段。

仅请求 activeTab、scripting、storage；没有所有网站 host_permissions，不保存 Cookie/API key。官方 Mozilla Readability（Apache-2.0）随构建包附带。正文从当前页面提取，不绕过访问限制。源页面表单、可编辑区域不会采集。实例 HTTP 模式会明文传输，请外网部署使用 HTTPS。

临时正文只在 extension storage.session 中短暂搬运，表单提交后移除；最多 10 分钟，未送出的旧条目在下次点击时清理。确认页按账号保存在当前标签页 sessionStorage；关闭会丢失。服务器保存后即是普通私有笔记，可跨设备访问，不自动发布。

浏览器内置页面、扩展商店页面不允许注入；超大、空正文、无法抓取或防盗链图片会明确提示。来源页面的 CSP 可能阻止剪藏书签；扩展不依赖来源页的表单策略。自托管实例证书警告不能由扩展绕过。
