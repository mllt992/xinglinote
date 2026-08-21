import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { bindLightbox, type LightboxImage } from "../lib/lightbox";

/**
 * 图片放大层。全站只挂一个，谁想放大就调 `openLightbox()`（见 lib/lightbox.ts）。
 *
 * 用现成的 Dialog 而不是自己拼一个：Esc 退出、焦点圈住、点遮罩关闭这几件事
 * Radix 已经按无障碍规范做好了，自己重写一遍只会漏。
 */
export function ImageLightbox() {
  const [image, setImage] = useState<LightboxImage | null>(null);
  useEffect(() => {
    bindLightbox(setImage);
    return () => bindLightbox(null);
  }, []);

  return (
    <Dialog open={!!image} onOpenChange={open => { if (!open) setImage(null); }}>
      {image && (
        <DialogContent className="max-w-[min(92vw,1200px)] gap-2 bg-background/95 p-3">
          {/* 无障碍要求对话框有标题；这里视觉上不需要，用 alt 当名字并藏起来 */}
          <DialogTitle className="sr-only">{image.alt || "图片"}</DialogTitle>
          <img
            src={image.src}
            alt={image.alt}
            className="mx-auto max-h-[82vh] w-auto max-w-full rounded-lg object-contain"
          />
          {image.alt && <p className="text-center text-xs text-muted-foreground">{image.alt}</p>}
        </DialogContent>
      )}
    </Dialog>
  );
}
