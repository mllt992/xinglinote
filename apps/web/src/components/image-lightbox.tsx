import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  ChevronLeft, ChevronRight, Download, ExternalLink, Info, LoaderCircle, Maximize,
  RefreshCw, RotateCcw, RotateCw, Scan, X, ZoomIn, ZoomOut,
} from "lucide-react";
import { type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clampImageOffset, clampImageScale, filenameFromImageUrl, fitImageScale,
  normalizedRotation, usefulImageLabel,
} from "../lib/image-viewer";
import { bindLightbox, type LightboxImage, type LightboxRequest } from "../lib/lightbox";
import { cn } from "../lib/utils";
import { Tooltip, TooltipProvider } from "./ui/tooltip";

type Point = { x: number; y: number };
type Gesture =
  | { kind: "drag"; pointerId: number; start: Point; offset: Point }
  | { kind: "pinch"; distance: number; midpoint: Point; scale: number; offset: Point };

function ToolButton({ label, children, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        className={cn(
          "inline-flex size-11 shrink-0 items-center justify-center rounded-md text-zinc-200 outline-none hover:bg-white/15 hover:text-white focus-visible:ring-2 focus-visible:ring-white/80 disabled:pointer-events-none disabled:opacity-35",
          className,
        )}
        {...props}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function imageDownloadName(item: LightboxImage) {
  return item.filename?.trim() || filenameFromImageUrl(item.src) || "image";
}

async function downloadImage(item: LightboxImage) {
  const fallback = () => {
    const link = document.createElement("a");
    link.href = item.src;
    link.download = imageDownloadName(item);
    link.target = "_blank";
    link.rel = "noopener";
    link.click();
  };

  try {
    const response = await fetch(item.src, { credentials: "include" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const objectUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = imageDownloadName(item);
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  } catch {
    fallback();
  }
}

function formatBytes(bytes?: number) {
  if (!bytes || bytes < 1) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function midpoint(points: Point[]) {
  return { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
}

function pointDistance(points: Point[]) {
  return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
}

function ImageViewer({ item, index, count, onClose, onPrevious, onNext }: {
  item: LightboxImage;
  index: number;
  count: number;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const gestureRef = useRef<Gesture | null>(null);
  const movedRef = useRef(false);
  const scaleRef = useRef(1);
  const offsetRef = useRef<Point>({ x: 0, y: 0 });
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scale, setScale] = useState(1);
  const [fitScale, setFitScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [mode, setMode] = useState<"fit" | "manual">("fit");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);

  const writeScale = useCallback((next: number) => {
    scaleRef.current = next;
    setScale(next);
  }, []);
  const writeOffset = useCallback((next: Point) => {
    offsetRef.current = next;
    setOffset(next);
  }, []);

  const clampOffset = useCallback((next: Point, nextScale = scaleRef.current, nextRotation = rotation) => {
    const node = viewportRef.current;
    if (!node || !natural.width || !natural.height) return { x: 0, y: 0 };
    return clampImageOffset(next.x, next.y, nextScale, nextRotation, natural.width, natural.height, node.clientWidth, node.clientHeight);
  }, [natural.height, natural.width, rotation]);

  const setFit = useCallback((nextRotation = rotation) => {
    const node = viewportRef.current;
    if (!node || !natural.width || !natural.height) return;
    const nextFit = fitImageScale(natural.width, natural.height, node.clientWidth, node.clientHeight, nextRotation);
    setFitScale(nextFit);
    writeScale(nextFit);
    writeOffset({ x: 0, y: 0 });
    setMode("fit");
  }, [natural.height, natural.width, rotation, writeOffset, writeScale]);

  const setActualSize = useCallback(() => {
    const nextScale = clampImageScale(1, fitScale);
    writeScale(nextScale);
    writeOffset(clampOffset(offsetRef.current, nextScale));
    setMode("manual");
  }, [clampOffset, fitScale, writeOffset, writeScale]);

  const zoomTo = useCallback((requested: number, client?: Point) => {
    const node = viewportRef.current;
    if (!node || !natural.width || !natural.height) return;
    const previous = scaleRef.current;
    const next = clampImageScale(requested, fitScale);
    if (Math.abs(next - previous) < 0.0001) return;
    let nextOffset = offsetRef.current;
    if (client) {
      const rect = node.getBoundingClientRect();
      const focal = { x: client.x - rect.left - rect.width / 2, y: client.y - rect.top - rect.height / 2 };
      const ratio = next / previous;
      nextOffset = { x: nextOffset.x * ratio + focal.x * (1 - ratio), y: nextOffset.y * ratio + focal.y * (1 - ratio) };
    }
    writeScale(next);
    writeOffset(clampOffset(nextOffset, next));
    setMode(Math.abs(next - fitScale) < 0.0001 ? "fit" : "manual");
  }, [clampOffset, fitScale, natural.height, natural.width, writeOffset, writeScale]);

  const rotate = useCallback((delta: number) => {
    const nextRotation = normalizedRotation(rotation + delta);
    setRotation(nextRotation);
    const node = viewportRef.current;
    if (!node || !natural.width || !natural.height) return;
    const nextFit = fitImageScale(natural.width, natural.height, node.clientWidth, node.clientHeight, nextRotation);
    setFitScale(nextFit);
    if (mode === "fit") {
      writeScale(nextFit);
      writeOffset({ x: 0, y: 0 });
    } else {
      writeOffset(clampImageOffset(offsetRef.current.x, offsetRef.current.y, scaleRef.current, nextRotation, natural.width, natural.height, node.clientWidth, node.clientHeight));
    }
  }, [mode, natural.height, natural.width, rotation, writeOffset, writeScale]);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const measure = () => {
      const next = { width: node.clientWidth, height: node.clientHeight };
      setViewport(current => current.width === next.width && current.height === next.height ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!natural.width || !natural.height || !viewport.width || !viewport.height) return;
    const nextFit = fitImageScale(natural.width, natural.height, viewport.width, viewport.height, rotation);
    setFitScale(nextFit);
    if (mode === "fit") {
      writeScale(nextFit);
      writeOffset({ x: 0, y: 0 });
    } else {
      writeOffset(clampImageOffset(offsetRef.current.x, offsetRef.current.y, scaleRef.current, rotation, natural.width, natural.height, viewport.width, viewport.height));
    }
  }, [mode, natural.height, natural.width, rotation, viewport.height, viewport.width, writeOffset, writeScale]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey) return;
      if (event.key === "+" || event.key === "=") zoomTo(scaleRef.current * 1.25);
      else if (event.key === "-" || event.key === "_") zoomTo(scaleRef.current / 1.25);
      else if (event.key === "0") setFit();
      else if (event.key === "1") setActualSize();
      else if (event.key.toLowerCase() === "r") rotate(event.shiftKey ? -90 : 90);
      else if (event.key === "ArrowLeft" && onPrevious) onPrevious();
      else if (event.key === "ArrowRight" && onNext) onNext();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onNext, onPrevious, rotate, setActualSize, setFit, zoomTo]);

  const beginPinch = useCallback(() => {
    const points = [...pointersRef.current.values()].slice(0, 2);
    if (points.length < 2) return;
    const node = viewportRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const center = midpoint(points);
    gestureRef.current = {
      kind: "pinch",
      distance: Math.max(1, pointDistance(points)),
      midpoint: { x: center.x - rect.left - rect.width / 2, y: center.y - rect.top - rect.height / 2 },
      scale: scaleRef.current,
      offset: offsetRef.current,
    };
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointersRef.current.size === 1) {
      movedRef.current = false;
      gestureRef.current = { kind: "drag", pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, offset: offsetRef.current };
    } else {
      beginPinch();
    }
  }, [beginPinch]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    event.preventDefault();
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (pointersRef.current.size >= 2) {
      if (gesture.kind !== "pinch") {
        beginPinch();
        return;
      }
      const points = [...pointersRef.current.values()].slice(0, 2);
      const node = viewportRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const center = midpoint(points);
      const currentMidpoint = { x: center.x - rect.left - rect.width / 2, y: center.y - rect.top - rect.height / 2 };
      const nextScale = clampImageScale(gesture.scale * pointDistance(points) / gesture.distance, fitScale);
      const ratio = nextScale / gesture.scale;
      const nextOffset = clampOffset({
        x: gesture.offset.x * ratio + gesture.midpoint.x * (1 - ratio) + currentMidpoint.x - gesture.midpoint.x,
        y: gesture.offset.y * ratio + gesture.midpoint.y * (1 - ratio) + currentMidpoint.y - gesture.midpoint.y,
      }, nextScale);
      writeScale(nextScale);
      writeOffset(nextOffset);
      setMode(Math.abs(nextScale - fitScale) < 0.0001 ? "fit" : "manual");
      movedRef.current = true;
      return;
    }
    if (gesture.kind === "drag" && gesture.pointerId === event.pointerId) {
      const dx = event.clientX - gesture.start.x;
      const dy = event.clientY - gesture.start.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) movedRef.current = true;
      writeOffset(clampOffset({ x: gesture.offset.x + dx, y: gesture.offset.y + dy }));
    }
  }, [beginPinch, clampOffset, fitScale, writeOffset, writeScale]);

  const endPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size === 1) {
      const [pointerId, point] = [...pointersRef.current.entries()][0];
      gestureRef.current = { kind: "drag", pointerId, start: point, offset: offsetRef.current };
    } else if (!pointersRef.current.size) {
      gestureRef.current = null;
    }
  }, []);

  const filename = item.filename?.trim() || filenameFromImageUrl(item.src);
  const caption = usefulImageLabel(item.alt) ? item.alt.trim() : usefulImageLabel(filename) ? filename : "";
  const metadata = [natural.width && natural.height ? `${natural.width} × ${natural.height}` : "", formatBytes(item.bytes)].filter(Boolean).join(" · ");
  const minScale = Math.min(0.1, fitScale);
  const displayPercent = Math.round(scale * 100);
  const viewReady = !!natural.width && !!natural.height && !error;

  return (
    <div className="grid h-[100dvh] w-screen min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-[#0b0b0d] text-white">
      <header className="z-20 flex min-h-14 w-full min-w-0 items-center gap-1 overflow-hidden border-b border-white/10 bg-black/55 px-1 opacity-90 backdrop-blur motion-safe:transition-opacity hover:opacity-100 focus-within:opacity-100 sm:px-3">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {count > 1 && <>
          <ToolButton label="上一张（←）" onClick={onPrevious} disabled={!onPrevious}><ChevronLeft className="size-5" /></ToolButton>
          <span className="shrink-0 px-1 text-xs tabular-nums text-zinc-300" aria-label={`第 ${index + 1} 张，共 ${count} 张`}>{index + 1} / {count}</span>
          <ToolButton label="下一张（→）" onClick={onNext} disabled={!onNext}><ChevronRight className="size-5" /></ToolButton>
          <span className="mx-1 h-6 w-px shrink-0 bg-white/15" />
        </>}
        <ToolButton label="缩小（-）" onClick={() => zoomTo(scaleRef.current / 1.25)} disabled={!viewReady || scale <= minScale + 0.0001}><ZoomOut className="size-5" /></ToolButton>
        <output className="w-14 shrink-0 text-center text-xs tabular-nums text-zinc-200" aria-label={`当前缩放 ${displayPercent}%`}>{displayPercent}%</output>
        <ToolButton label="放大（+）" onClick={() => zoomTo(scaleRef.current * 1.25)} disabled={!viewReady || scale >= 5 - 0.0001}><ZoomIn className="size-5" /></ToolButton>
        <ToolButton label="适应窗口（0）" onClick={() => setFit()} disabled={!viewReady}><Maximize className="size-5" /></ToolButton>
        <ToolButton label="实际大小（1）" onClick={setActualSize} disabled={!viewReady}><Scan className="size-5" /></ToolButton>
        <span className="mx-1 h-6 w-px shrink-0 bg-white/15" />
        <ToolButton label="向左旋转（Shift+R）" onClick={() => rotate(-90)} disabled={!viewReady}><RotateCcw className="size-5" /></ToolButton>
        <ToolButton label="向右旋转（R）" onClick={() => rotate(90)} disabled={!viewReady}><RotateCw className="size-5" /></ToolButton>
        <span className="mx-1 h-6 w-px shrink-0 bg-white/15" />
        <ToolButton label="下载原图" onClick={() => void downloadImage(item)}><Download className="size-5" /></ToolButton>
        <ToolButton label="在新窗口打开原图" onClick={() => window.open(item.src, "_blank", "noopener,noreferrer")}><ExternalLink className="size-5" /></ToolButton>
        </div>
        <ToolButton label="关闭（Esc）" onClick={onClose}><X className="size-5" /></ToolButton>
      </header>

      <div
        ref={viewportRef}
        className={cn(
          "relative flex min-h-0 select-none items-center justify-center overflow-hidden overscroll-contain bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.055),transparent_62%)] touch-none",
          natural.width && natural.height && (scale > fitScale + 0.0001 || Math.abs(offset.x) + Math.abs(offset.y) > 0) ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onWheel={event => { event.preventDefault(); zoomTo(scaleRef.current * Math.exp(-event.deltaY * 0.0015), { x: event.clientX, y: event.clientY }); }}
        onDoubleClick={event => {
          event.preventDefault();
          if (Math.abs(scaleRef.current - fitScale) < 0.0001) zoomTo(1, { x: event.clientX, y: event.clientY });
          else setFit();
        }}
        onClick={event => {
          if (event.target === event.currentTarget && !movedRef.current) onClose();
          movedRef.current = false;
        }}
      >
        {loading && !error && <LoaderCircle className="absolute size-8 animate-spin text-zinc-400 motion-reduce:animate-none" aria-label="图片加载中" />}
        {error ? (
          <div className="relative z-10 flex max-w-sm flex-col items-center gap-3 rounded-xl border border-white/10 bg-black/55 p-6 text-center">
            <p className="text-sm text-zinc-200">图片加载失败</p>
            <div className="flex gap-2">
              <button type="button" className="inline-flex min-h-11 items-center gap-2 rounded-md bg-white/10 px-4 text-sm hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80" onClick={() => { setError(false); setLoading(true); setRetry(value => value + 1); }}><RefreshCw className="size-4" />重试</button>
              <button type="button" className="inline-flex min-h-11 items-center gap-2 rounded-md bg-white/10 px-4 text-sm hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80" onClick={() => void downloadImage(item)}><Download className="size-4" />下载原图</button>
            </div>
          </div>
        ) : (
          <img
            key={retry}
            src={item.src}
            alt={item.alt || caption || "查看图片"}
            draggable={false}
            className={cn("max-w-none will-change-transform motion-reduce:transition-none", loading && "invisible")}
            style={{ width: natural.width || "auto", height: natural.height || "auto", transform: `translate3d(${offset.x}px, ${offset.y}px, 0) rotate(${rotation}deg) scale(${scale})` }}
            onLoad={event => {
              const image = event.currentTarget;
              const node = viewportRef.current;
              const nextNatural = { width: image.naturalWidth, height: image.naturalHeight };
              setNatural(nextNatural);
              setLoading(false);
              setError(false);
              if (node) {
                const nextFit = fitImageScale(nextNatural.width, nextNatural.height, node.clientWidth, node.clientHeight, rotation);
                setFitScale(nextFit);
                writeScale(nextFit);
                writeOffset({ x: 0, y: 0 });
                setMode("fit");
              }
            }}
            onError={() => { setLoading(false); setError(true); }}
          />
        )}
        <p className="sr-only" aria-live="polite">{error ? "图片加载失败" : loading ? "图片加载中" : `图片已加载，当前缩放 ${displayPercent}%`}</p>
      </div>

      {caption && (
        <details className="group z-20 border-t border-white/10 bg-black/60 text-zinc-200">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/80 [&::-webkit-details-marker]:hidden">
            <Info className="size-4 shrink-0 text-zinc-400" />
            <span className="min-w-0 flex-1 truncate">{caption}</span>
            {metadata && <span className="shrink-0 text-xs tabular-nums text-zinc-500">{metadata}</span>}
          </summary>
          <div className="max-h-28 overflow-auto border-t border-white/5 px-4 py-2 text-sm break-words">{caption}</div>
        </details>
      )}
    </div>
  );
}

/** 全站唯一图片查看器：Radix 负责焦点圈定、Esc 关闭和关闭后的焦点归还。 */
export function ImageLightbox() {
  const [request, setRequest] = useState<LightboxRequest | null>(null);

  useEffect(() => {
    bindLightbox(setRequest);
    return () => bindLightbox(null);
  }, []);

  const item = request?.items[request.index];
  const close = useCallback(() => setRequest(null), []);
  const moveTo = useCallback((index: number) => {
    setRequest(current => current ? { ...current, index: Math.min(Math.max(index, 0), current.items.length - 1) } : current);
  }, []);

  useEffect(() => {
    if (!request || request.items.length < 2) return;
    for (const adjacentIndex of [request.index - 1, request.index + 1]) {
      const adjacent = request.items[adjacentIndex];
      if (adjacent) {
        const image = new Image();
        image.src = adjacent.src;
      }
    }
  }, [request]);

  const title = useMemo(() => item && usefulImageLabel(item.alt) ? item.alt : "图片查看器", [item]);

  return (
    <TooltipProvider delayDuration={300}>
    <DialogPrimitive.Root open={!!item} onOpenChange={open => { if (!open) close(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[110] bg-black/90 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 motion-reduce:animate-none" />
        {item && request && (
          <DialogPrimitive.Content
            aria-describedby={undefined}
            className="fixed inset-0 z-[110] overflow-hidden outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 motion-reduce:animate-none"
          >
            <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
            <ImageViewer
              key={`${request.index}:${item.src}`}
              item={item}
              index={request.index}
              count={request.items.length}
              onClose={close}
              onPrevious={request.index > 0 ? () => moveTo(request.index - 1) : undefined}
              onNext={request.index < request.items.length - 1 ? () => moveTo(request.index + 1) : undefined}
            />
          </DialogPrimitive.Content>
        )}
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
    </TooltipProvider>
  );
}
