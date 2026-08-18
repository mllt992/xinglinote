// PDF 抽文本：抽出来进关键词索引，抽不出来也不影响文件本身（规格 06 的 4.3）。
const MAX_CHARS = 200_000;
const MAX_PAGES = 500;

/**
 * 用 pdfjs 的 legacy 构建，它不依赖浏览器 API，在 Node 里可直接跑。
 * 失败一律抛错，由调用方记 failed，不要吞掉。
 */
export async function extractPdfText(bytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdfjs 6 不再随包发标准字体表，控制台会留一条 standardFontDataUrl 的 warning；
  // 只影响标准字体的字形映射，取文字不受影响，所以不去补这份数据。
  const doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: false, disableFontFace: true }).promise;
  try {
    const pages: string[] = [];
    let total = 0;
    for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGES) && total < MAX_CHARS; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map(item => ("str" in item ? item.str : "")).join("").replace(/\s+/g, " ").trim();
      page.cleanup();
      if (!text) continue;
      pages.push(text);
      total += text.length;
    }
    return pages.join("\n\n").slice(0, MAX_CHARS);
  } finally {
    await doc.cleanup();
  }
}
