import { Children, isValidElement, useEffect, useState, type ReactNode } from "react";
import { Maximize2, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

type ThemeName = "dark" | "light";

function pageTheme(): ThemeName {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function usePageTheme(): ThemeName {
  const [theme, setTheme] = useState<ThemeName>(pageTheme);
  useEffect(() => {
    const el = document.documentElement;
    const sync = () => setTheme(el.dataset.theme === "light" ? "light" : "dark");
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

function reactNodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(reactNodeText).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return reactNodeText(props.children);
  }
  return "";
}

/** Fence body for the copy button. One trailing newline is the markdown closer, not content. */
export function fenceText(children: ReactNode): string {
  return reactNodeText(children).replace(/\n$/, "");
}

/** Fenced ```mermaid source, or null when this pre is not a mermaid diagram. */
export function mermaidSource(children: ReactNode): string | null {
  for (const node of Children.toArray(children)) {
    if (!isValidElement(node)) continue;
    const props = node.props as { className?: unknown; children?: ReactNode };
    const className = typeof props.className === "string" ? props.className : "";
    const match = /(?:^|\s)language-([\w-]+)/.exec(className);
    if (!match || match[1].toLowerCase() !== "mermaid") continue;
    return fenceText(props.children);
  }
  return null;
}

/** Case-insensitive sequenceDiagram tokens. A participant named Box is lexed as `box`, not an actor. */
const SEQUENCE_RESERVED = new Set([
  "box", "end", "note", "loop", "alt", "else", "opt", "par", "and", "critical",
  "option", "break", "rect", "activate", "deactivate", "create", "destroy",
  "autonumber", "title", "participant", "actor", "over",
]);

const SEQUENCE_ARROW = /(?:<<-->>|<<->>|-->>|->>|-->|->|--x|-x|--\)|-\))/;

function quoteReservedWords(text: string): string {
  return text.replace(/(^|[^"\w])([A-Za-z_][\w-]*)/g, (full, pre: string, word: string) => {
    if (!SEQUENCE_RESERVED.has(word.toLowerCase())) return full;
    return `${pre}"${word}"`;
  });
}

function quoteActorId(raw: string): string {
  const bare = raw.replace(/^"|"$/g, "");
  return SEQUENCE_RESERVED.has(bare.toLowerCase()) ? `"${bare}"` : raw;
}

function rewriteSequenceLine(line: string): string {
  if (/^\s*(?:end|else|and)\s*$/i.test(line)) return line;
  if (/^\s*box\b/i.test(line) && !SEQUENCE_ARROW.test(line)) return line;

  const decl = /^(\s*(?:participant|actor)\s+)("[^"]+"|\S+)(.*)$/i.exec(line);
  if (decl) return decl[1] + quoteActorId(decl[2]) + decl[3];

  const created = /^(\s*create\s+(?:participant|actor)\s+)("[^"]+"|\S+)(.*)$/i.exec(line);
  if (created) return created[1] + quoteActorId(created[2]) + created[3];

  const note = /^(\s*note\s+(?:left\s+of|right\s+of|over)\s+)(.*)$/i.exec(line);
  if (note) {
    const colon = note[2].indexOf(":");
    const targets = colon < 0 ? note[2] : note[2].slice(0, colon);
    const rest = colon < 0 ? "" : note[2].slice(colon);
    return note[1] + quoteReservedWords(targets) + rest;
  }

  const life = /^(\s*(?:activate|deactivate|destroy)\s+)("[^"]+"|\S+)(.*)$/i.exec(line);
  if (life) return life[1] + quoteActorId(life[2]) + life[3];

  if (SEQUENCE_ARROW.test(line)) {
    const colon = line.indexOf(":");
    const head = colon < 0 ? line : line.slice(0, colon);
    const tail = colon < 0 ? "" : line.slice(colon);
    return quoteReservedWords(head) + tail;
  }
  return line;
}

/** Quote actor ids that mermaid would otherwise lex as sequenceDiagram keywords. */
export function quoteReservedSequenceActors(source: string): string {
  if (!/^\s*sequenceDiagram\b/i.test(source)) return source;
  return source.split("\n").map(rewriteSequenceLine).join("\n");
}

let mermaidSeq = 0;

/** Off-screen measuring box. mermaid.render otherwise appends a full diagram to document.body. */
export const MERMAID_RENDER_HOST_STYLE = "position:fixed;left:-10000px;top:0;width:640px;pointer-events:none;";

function mermaidRenderHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.setAttribute("data-armada-mermaid-host", "");
  host.style.cssText = MERMAID_RENDER_HOST_STYLE;
  return host;
}

function acceptSvg(svg: string): string {
  const trimmed = svg.trim();
  if (!trimmed.includes("<svg")) throw new Error("mermaid svg");
  if (/<script[\s>]/i.test(trimmed)) throw new Error("mermaid script");
  return trimmed;
}

async function renderMermaid(source: string, theme: ThemeName, host: HTMLElement): Promise<string> {
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    suppressErrorRendering: true,
    theme: theme === "dark" ? "dark" : "default",
    themeVariables: {
      background: "transparent",
      fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, sans-serif",
    },
  });
  const id = `armadaMermaid${mermaidSeq++}`;
  const { svg } = await mermaid.render(id, quoteReservedSequenceActors(source), host);
  return acceptSvg(svg);
}

/** Inline card height. Taller diagrams scale down inside it instead of filling the thread. */
export const MERMAID_PREVIEW_MAX_PX = 220;
export const MERMAID_ZOOM_MIN = 0.5;
export const MERMAID_ZOOM_MAX = 3;
export const MERMAID_ZOOM_STEP = 0.25;

export function nextMermaidZoom(current: number, delta: number): number {
  const next = Math.round((current + delta) * 100) / 100;
  return Math.min(MERMAID_ZOOM_MAX, Math.max(MERMAID_ZOOM_MIN, next));
}

/**
 * mermaid 12 writes width="100%" and no height. Preview CSS uses width/height auto,
 * so that SVG lays out at 0×0 and the card looks empty. Pin the viewBox size.
 */
export function svgWithIntrinsicSize(svg: string): string {
  const box = /viewBox="\s*[-\d.]+\s+[-\d.]+\s+([-\d.]+)\s+([-\d.]+)\s*"/.exec(svg);
  if (!box) return svg;
  const w = Number(box[1]);
  const h = Number(box[2]);
  if (!(w > 0) || !(h > 0)) return svg;
  return svg.replace(/<svg\b([^>]*)>/i, (_full, attrs: string) => {
    const next = attrs.replace(/\swidth="[^"]*"/i, "").replace(/\sheight="[^"]*"/i, "");
    return `<svg${next} width="${w}" height="${h}">`;
  });
}

/** Dialog copy must not reuse the preview's svg ids, or one diagram's markers blank the other. */
export function isolateSvgIds(svg: string, prefix: string): string {
  return svg
    .replace(/\bid="([^"]+)"/g, (_, id: string) => `id="${prefix}${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_, id: string) => `url(#${prefix}${id})`)
    .replace(/href="#([^"]+)"/g, (_, id: string) => `href="#${prefix}${id}"`);
}

function svgPrefix(svg: string): string {
  let hash = 0;
  for (let i = 0; i < svg.length; i++) hash = (hash * 31 + svg.charCodeAt(i)) >>> 0;
  return `d${hash.toString(36)}-`;
}

function ExpandIcon() {
  return <Maximize2 className="size-3.5" aria-hidden />;
}

export function MermaidView({ svg, defaultOpen = false }: { svg: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [zoom, setZoom] = useState(1);
  const dialogSvg = isolateSvgIds(svg, svgPrefix(svg));
  return (
    <>
      <div className="mermaid-block relative mb-2 overflow-hidden rounded-md border border-border bg-muted/30">
        <div className="mermaid-preview" aria-label="流程图">
          <div dangerouslySetInnerHTML={{ __html: svg }} />
        </div>
        <button
          type="button"
          aria-label="展开流程图"
          title="展开流程图"
          onClick={() => setOpen(true)}
          className="absolute top-1.5 right-1.5 z-10 rounded-md border border-border bg-background/90 p-1 text-muted-foreground hover:text-foreground"
        >
          <ExpandIcon />
        </button>
      </div>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setZoom(1);
        }}
      >
        <DialogContent
          aria-label="流程图"
          className="flex h-[min(90vh,860px)] w-[min(1100px,calc(100vw-2rem))] max-w-none flex-col gap-2 overflow-hidden p-3 sm:max-w-none"
        >
          <DialogHeader className="flex-row items-center gap-1 pr-8">
            <DialogTitle className="text-[13px]">流程图</DialogTitle>
            <Button type="button" variant="outline" size="icon-sm" aria-label="放大" onClick={() => setZoom((z) => nextMermaidZoom(z, MERMAID_ZOOM_STEP))}>
              <ZoomIn />
            </Button>
            <Button type="button" variant="outline" size="icon-sm" aria-label="缩小" onClick={() => setZoom((z) => nextMermaidZoom(z, -MERMAID_ZOOM_STEP))}>
              <ZoomOut />
            </Button>
            <Button type="button" variant="outline" size="icon-sm" aria-label="重置" onClick={() => setZoom(1)}>
              <RotateCcw />
            </Button>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto">
            <div className="mermaid-dialog" style={{ width: `${zoom * 100}%` }} dangerouslySetInnerHTML={{ __html: dialogSvg }} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function MermaidChart({ source }: { source: string }) {
  const theme = usePageTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    const host = mermaidRenderHost();
    document.body.appendChild(host);
    void renderMermaid(source, theme, host).then(
      (next) => { if (!cancelled) setSvg(svgWithIntrinsicSize(next)); },
      () => { if (!cancelled) setFailed(true); },
    ).finally(() => host.remove());
    return () => { cancelled = true; };
  }, [source, theme]);
  if (failed) {
    return (
      <pre className="mb-2 p-2.5 rounded-md bg-muted overflow-x-auto text-[12px]">
        <code>{source}</code>
      </pre>
    );
  }
  if (!svg) {
    return <div className="mermaid-block mb-2 min-h-8 rounded-md bg-muted/40" aria-busy="true" aria-label="流程图" />;
  }
  return <MermaidView svg={svg} />;
}
