import { makeZip } from '../zip.ts';

/** 合成样本：官方 Notion Markdown & CSV 导出布局，不含真实用户数据。 */
export const FIXTURE_PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAKAAAABgCAIAAAAVRe7OAAABG0lEQVR4nO3dwQnCUBBAQRVL8WoDIV16txqxgTSUDnL4MQYeM/eFhcee9/p4vy503c5egGMJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdw3H3P8Pf5+dUebJuWeWzQBccJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxux5jDX9r4m9ccJzAcQLHCRwncJzAcQLHCRwncJzAcQLHCRwncJzAcQLHCRwncJzAcSuUwAZiVPIx/QAAAABJRU5ErkJggg==','base64');
export function notionExportFixture(pages=55) {
  const root=`合成知识库 ${'a'.repeat(32)}`, entries=[{path:`${root}.md`,data:Buffer.from(`# 合成知识库\n\n合成迁移验收样本（不是用户真实导出）\n\n[第一页](<${root}/项目 ${'b'.repeat(32)}/页面 01 ${'1'.padStart(32,'0')}.md>)`)}];
  for(let index=1;index<=pages;index++){
    const section=index<=30?'项目':'归档',sectionId=index<=30?'b'.repeat(32):'c'.repeat(32),title=`页面 ${String(index).padStart(2,'0')}`;
    entries.push({path:`${root}/${section} ${sectionId}/${title} ${index.toString(16).padStart(32,'0')}.md`,data:Buffer.from(`# ${title}\n\n合成正文 ${index}\n\n- [ ] 待办\n- [x] 已完成\n\n![主图](../../assets/hero.png)\n\n[附件](../../assets/readme.txt)`)});
  }
  entries.push({path:`${root}/数据库 ${'d'.repeat(32)}.csv`,data:Buffer.from('名称,状态,备注\n任务一,进行中,"含逗号,与说明"\n任务二,完成,"多行\n说明"')});
  entries.push({path:'assets/hero.png',data:FIXTURE_PNG},{path:'assets/readme.txt',data:Buffer.from('合成附件，校验内容寻址去重')});
  return makeZip(entries,new Date('2026-01-01T00:00:00Z'));
}
export function wordExportFixture() {
  return makeZip([
    {path:'[Content_Types].xml',data:Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')},
    {path:'_rels/.rels',data:Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')},
    {path:'word/_rels/document.xml.rels',data:Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>')},
    {path:'word/document.xml',data:Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>合成 Word 标题</w:t></w:r></w:p><w:p><w:r><w:t>Word 正文</w:t></w:r></w:p><w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="图片"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="image1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>')},
    {path:'word/media/image1.png',data:FIXTURE_PNG},
  ]);
}
