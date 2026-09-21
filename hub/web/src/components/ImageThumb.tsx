import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { isConsoleImage } from "../attachments";

function canMakeObjectUrl(): boolean {
  return typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
}

function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const overlay = (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={alt || "图片预览"}
      onClick={onClose}
    >
      <img
        src={src}
        alt={alt}
        className="max-h-[90vh] max-w-[90vw] rounded-xl object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
  if (typeof document === "undefined") return overlay;
  return createPortal(overlay, document.body);
}

function useObjectUrl(file: File | null): string {
  const [src, setSrc] = useState("");
  useEffect(() => {
    if (!file || !canMakeObjectUrl()) return;
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return src;
}

const hubBlobUrlCache = new Map<string, Promise<string>>();

function hubBlobUrl(id: string): Promise<string> {
  const hit = hubBlobUrlCache.get(id);
  if (hit) return hit;
  const p = api.getBlob(id).then((blob) => {
    const mime = blob.type || "";
    if (mime && mime !== "image/png" && mime !== "image/jpeg") throw new Error("NOT_IMAGE");
    if (!canMakeObjectUrl()) throw new Error("NO_OBJECT_URL");
    return URL.createObjectURL(blob);
  });
  hubBlobUrlCache.set(id, p);
  p.catch(() => { hubBlobUrlCache.delete(id); });
  return p;
}

function useHubBlobUrl(id: string): string {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let stop = false;
    void hubBlobUrl(id).then((url) => {
      if (!stop) setSrc(url);
    }).catch(() => {});
    return () => { stop = true; };
  }, [id]);
  return src;
}

function ComposerChip({
  src, alt, onRemove, onOpen,
}: {
  src: string;
  alt: string;
  onRemove: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="relative size-14 shrink-0">
      <button
        type="button"
        className="size-14 overflow-hidden rounded-lg bg-muted ring-1 ring-foreground/10"
        aria-label={`查看 ${alt}`}
        title={alt}
        onClick={onOpen}
      >
        {src ? <img src={src} alt={alt} className="size-full object-cover" /> : null}
      </button>
      <button
        type="button"
        aria-label="移除"
        className="absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full bg-black/60 text-[12px] leading-none text-white hover:bg-black/80"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
      >
        ×
      </button>
    </div>
  );
}

export function LocalImageChip({ file, onRemove }: { file: File; onRemove: () => void }) {
  const src = useObjectUrl(isConsoleImage(file) ? file : null);
  const [open, setOpen] = useState(false);
  const alt = file.name || "粘贴的图片";
  return (
    <>
      <ComposerChip src={src} alt={alt} onRemove={onRemove} onOpen={() => { if (src) setOpen(true); }} />
      {open && src ? <ImageLightbox src={src} alt={alt} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function MessageThumb({ src, alt }: { src: string; alt: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="size-36 shrink-0 overflow-hidden rounded-xl bg-muted ring-1 ring-foreground/10"
        aria-label={`查看 ${alt}`}
        title={alt}
        onClick={() => { if (src) setOpen(true); }}
      >
        {src ? <img src={src} alt={alt} className="size-full object-cover" /> : null}
      </button>
      {open && src ? <ImageLightbox src={src} alt={alt} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function HubMessageThumb({ id }: { id: string }) {
  const src = useHubBlobUrl(id);
  return <MessageThumb src={src} alt="图片" />;
}

export function HubImageRow({ ids }: { ids: string[] }) {
  if (!ids.length) return null;
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {ids.map((id, i) => <HubMessageThumb key={`${id}-${i}`} id={id} />)}
    </div>
  );
}
