/** 官方 sb=0 使用视图平移，避免浏览器滚动区域的固定边界限制画布。 */
export function drawioFrameUrl(drawioUrl: string, editable: boolean, dark: boolean) {
  const params = new URLSearchParams({ embed: "1", proto: "json", spin: "1", lang: "zh", ui: "kennedy", dark: dark ? "1" : "0", libraries: "1", noSaveBtn: "1", noExitBtn: "1", saveAndExit: "0", sb: "0" });
  if (!editable) params.set("chrome", "0");
  return `${drawioUrl}/?${params.toString()}`;
}
