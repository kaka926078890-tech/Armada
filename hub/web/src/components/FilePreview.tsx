import { useEffect, useState } from "react";
import { api } from "../api";
import { workspaceFileOperatorCopy } from "../../../../extension/src/workspaceFile";
import { AssistantMarkdown } from "./ChatThread";
import { Button } from "./ui/button";
import { UI_META, UI_TYPE } from "../ui";

function copyText(text: string): void {
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch { /* ignore */ }
    ta.remove();
  };
  if (!navigator.clipboard?.writeText) { fallback(); return; }
  void navigator.clipboard.writeText(text).catch(fallback);
}

export default function FilePreview({
  runId, path, onBack, onOpenFile,
}: {
  runId: string;
  path: string;
  onBack: () => void;
  onOpenFile: (next: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [name, setName] = useState(path.split(/[\\/]/).pop() ?? path);
  const [mime, setMime] = useState("text/plain");
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setText("");
    setCopied(false);
    void api.workspaceFile(runId, path).then((r) => {
      if (cancelled) return;
      if (r.error) {
        setError(workspaceFileOperatorCopy(r.error));
        setLoading(false);
        return;
      }
      setName(r.name || path.split(/[\\/]/).pop() || path);
      setMime(r.mime || "text/plain");
      setText(r.text ?? "");
      setLoading(false);
    }).catch((e) => {
      if (cancelled) return;
      setError(String(e));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [runId, path]);

  const markdown = mime === "text/markdown" || /\.md$/i.test(name);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-4 py-2 border-b border-border flex items-center gap-2 shrink-0">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>返回</Button>
        <div className={`min-w-0 truncate ${UI_TYPE} text-foreground`} title={path}>{name}</div>
        {text ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => {
              copyText(text);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            }}
          >
            {copied ? "已复制" : "复制"}
          </Button>
        ) : null}
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {loading ? <div className={`${UI_META} text-muted-foreground`}>正在读取…</div> : null}
        {error ? <div className={`${UI_TYPE} text-destructive`} role="alert">{error}</div> : null}
        {!loading && !error && markdown ? <AssistantMarkdown text={text} onOpenFile={onOpenFile} /> : null}
        {!loading && !error && !markdown ? (
          <pre className={`${UI_TYPE} whitespace-pre-wrap break-words text-foreground`}>{text}</pre>
        ) : null}
      </div>
    </div>
  );
}
