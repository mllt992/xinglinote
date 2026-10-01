/**
 * 编辑器导出转换：用浏览器 CSS/XML 解析器把有限展示样式转成 SVG 属性。
 * 不插入文档、不加载资源；真正的安全边界仍是服务端 SVG 白名单。
 */
export function normalizeBoardPreviewSvg(raw: string) {
  const doc = new DOMParser().parseFromString(raw, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.localName !== 'svg' || doc.querySelector('parsererror')) throw new Error('编辑器没有生成有效 SVG');
  const width = Number.parseFloat(root.getAttribute('width') ?? ''), height = Number.parseFloat(root.getAttribute('height') ?? '');
  if (!root.hasAttribute('viewBox') && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) root.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const properties = ['fill', 'stroke', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'fill-opacity', 'stroke-opacity', 'stroke-width', 'opacity'];
  for (const element of [root, ...root.querySelectorAll('*')]) {
    const style = (element as SVGElement).style;
    if (!style) continue;
    for (const property of properties) {
      const value = style.getPropertyValue(property).trim();
      if (value) element.setAttribute(property, value);
    }
  }
  return new XMLSerializer().serializeToString(root);
}
