export const IMAGE_MIN_SCALE = 0.1;
export const IMAGE_MAX_SCALE = 5;

export function normalizedRotation(rotation: number) {
  return ((rotation % 360) + 360) % 360;
}

/** 旋转后的图片完整放进舞台；小图默认不放大，保持真实像素。 */
export function fitImageScale(naturalWidth: number, naturalHeight: number, viewportWidth: number, viewportHeight: number, rotation: number, padding = 24) {
  if (naturalWidth <= 0 || naturalHeight <= 0 || viewportWidth <= 0 || viewportHeight <= 0) return 1;
  const sideways = normalizedRotation(rotation) % 180 !== 0;
  const width = sideways ? naturalHeight : naturalWidth;
  const height = sideways ? naturalWidth : naturalHeight;
  return Math.min(1, Math.max(0.001, (viewportWidth - padding * 2) / width), Math.max(0.001, (viewportHeight - padding * 2) / height));
}

export function clampImageScale(scale: number, fitScale: number) {
  return Math.min(IMAGE_MAX_SCALE, Math.max(Math.min(IMAGE_MIN_SCALE, fitScale), scale));
}

/** 图片中心不能被拖出舞台到完全找不回来；小于舞台时始终自动居中。 */
export function clampImageOffset(x: number, y: number, scale: number, rotation: number, naturalWidth: number, naturalHeight: number, viewportWidth: number, viewportHeight: number) {
  const sideways = normalizedRotation(rotation) % 180 !== 0;
  const renderedWidth = (sideways ? naturalHeight : naturalWidth) * scale;
  const renderedHeight = (sideways ? naturalWidth : naturalHeight) * scale;
  const maxX = Math.max(0, (renderedWidth - viewportWidth) / 2);
  const maxY = Math.max(0, (renderedHeight - viewportHeight) / 2);
  return {
    x: maxX === 0 ? 0 : Math.min(maxX, Math.max(-maxX, x)),
    y: maxY === 0 ? 0 : Math.min(maxY, Math.max(-maxY, y)),
  };
}

export function filenameFromImageUrl(src: string) {
  try {
    const last = new URL(src, "http://local.invalid").pathname.split("/").filter(Boolean).at(-1) ?? "";
    return decodeURIComponent(last);
  } catch { return ""; }
}

/** UUID、长哈希和内部 blob 名不拿来当视觉标题。 */
export function usefulImageLabel(label: string) {
  const value = label.trim();
  if (!value) return false;
  const stem = value.replace(/\.[a-z0-9]{1,8}$/i, "");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stem)) return false;
  if (/^[a-z0-9_-]{24,}$/i.test(stem) && /\d/.test(stem)) return false;
  return true;
}
