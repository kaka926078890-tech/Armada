import { Children, isValidElement, useEffect, useState, type ReactNode } from "react";

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

/** Fenced ```mermaid source, or null when this pre is not a mermaid diagram. */
export function mermaidSource(children: ReactNode): string | null {
  for (const node of Children.toArray(children)) {
    if (!isValidElement(node)) continue;
    const props = node.props as { className?: unknown; children?: ReactNode };
    const className = typeof props.className === "string" ? props.className : "";
    const match = /(?:^|\s)language-([\w-]+)/.exec(className);
    if (!match || match[1].toLowerCase() !== "mermaid") continue;
    return reactNodeText(props.children).replace(/\n$/, "");
  }
  return null;
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
  const { svg } = await mermaid.render(id, source, host);
  return acceptSvg(svg);
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
      (next) => { if (!cancelled) setSvg(next); },
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
  return (
    <div
      className="mermaid-block mb-2 overflow-x-auto"
      aria-label="流程图"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
