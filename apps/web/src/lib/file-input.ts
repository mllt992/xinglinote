/**
 * 从 <input type="file"> 取出本次选中的文件，并清空 input 以便下次还能选同一个文件。
 *
 * 必须先拷成数组再清空：Chromium 里 `input.files` 是活的 FileList，
 * 执行 `input.value = ""` 会把**同一个** FileList 清成 0 项。
 * 先拿引用、后清空、再读 length，拿到的永远是空——导入按钮「点了没反应」（#58）就是这么来的。
 */
export function takeInputFiles(input: { files: ArrayLike<File> | null; value: string }): File[] {
  const files = input.files ? Array.from(input.files) : [];
  input.value = "";
  return files;
}
