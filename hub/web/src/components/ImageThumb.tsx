import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { displayAttachmentName, isConsoleImage } from "../attachments";

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

type HubBlobView = { url: string; name: string; image: boolean };

const hubBlobViewCache = new Map<string, Promise<HubBlobView>>();

function hubBlobView(id: string): Promise<HubBlobView> {
  const hit = hubBlobViewCache.get(id);
  if (hit) return hit;
  const p = api.getBlob(id).then(({ blob, name }) => {
    const mime = (blob.type || "").split(";")[0]?.trim() ?? "";
    const image = mime === "image/png" || mime === "image/jpeg";
    if (!canMakeObjectUrl()) throw new Error("NO_OBJECT_URL");
    return { url: URL.createObjectURL(blob), name: name || "附件", image };
  });
  hubBlobViewCache.set(id, p);
  p.catch(() => { hubBlobViewCache.delete(id); });
  return p;
}

function useHubBlobView(id: string): HubBlobView | null {
  const [view, setView] = useState<HubBlobView | null>(null);
  useEffect(() => {
    let stop = false;
    void hubBlobView(id).then((next) => {
      if (!stop) setView(next);
    }).catch(() => {});
    return () => { stop = true; };
  }, [id]);
  return view;
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

function FileChip({ name, href }: { name: string; href: string }) {
  const label = displayAttachmentName(name);
  return (
    <a
      href={href}
      download={name}
      className="inline-flex max-w-full min-w-0 items-center gap-2 rounded-xl bg-background px-3 py-2 text-[13px] text-foreground ring-1 ring-foreground/10"
      title={name}
    >
      <span className="shrink-0 text-muted-foreground">文件</span>
      <span className="min-w-0 truncate">{label}</span>
    </a>
  );
}

function HubMessageThumb({ id }: { id: string }) {
  const view = useHubBlobView(id);
  if (view && !view.image) return <FileChip name={view.name} href={view.url} />;
  return <MessageThumb src={view?.url ?? ""} alt="图片" />;
}

export function HubImageRow({ ids }: { ids: string[] }) {
  if (!ids.length) return null;
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {ids.map((id, i) => <HubMessageThumb key={`${id}-${i}`} id={id} />)}
    </div>
  );
}
