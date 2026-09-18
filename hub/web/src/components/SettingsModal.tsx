import { useEffect, useState } from "react";
import type { FontScale, ThemeName } from "../theme";
import { snippetOperatorMessage } from "../promptSnippets";
import type { PromptSnippet } from "../uiPrefs";

const SEG = "px-2 py-0.5 rounded border text-[12px] whitespace-nowrap";
const ON = "border-sky-600 bg-sky-900/40 text-zinc-100";
const OFF = "border-zinc-700 text-zinc-400 hover:text-zinc-100";

function SnippetRow({
  snippet, onSave, onDelete,
}: {
  snippet: PromptSnippet;
  onSave: (next: PromptSnippet) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [title, setTitle] = useState(snippet.title);
  const [body, setBody] = useState(snippet.body);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTitle(snippet.title);
    setBody(snippet.body);
  }, [snippet.id, snippet.title, snippet.body]);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(snippetOperatorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 rounded border border-zinc-800 p-2">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="px-2 py-1 rounded bg-zinc-950 border border-zinc-700 text-[13px]"
        aria-label="标题"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        className="px-2 py-1 rounded bg-zinc-950 border border-zinc-700 text-[13px] resize-y"
        aria-label="提示词"
      />
      {error && <div className="text-red-400 text-sm">{error}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" disabled={busy} className={`${SEG} ${OFF}`} onClick={() => void run(() => onSave({ ...snippet, title, body }))}>保存</button>
        <button type="button" disabled={busy} className={`${SEG} ${OFF}`} onClick={() => void run(onDelete)}>删除</button>
      </div>
    </div>
  );
}

export default function SettingsModal({
  theme, fontScale, onTheme, onFontScale, onClose,
  snippets = [], saveSnippets, reloadSnippets, snippetError = "",
}: {
  theme: ThemeName;
  fontScale: FontScale;
  onTheme: (theme: ThemeName) => void;
  onFontScale: (scale: FontScale) => void;
  onClose: () => void;
  snippets?: PromptSnippet[];
  saveSnippets?: (next: PromptSnippet[]) => Promise<void>;
  reloadSnippets?: () => void;
  snippetError?: string;
}) {
  useEffect(() => { reloadSnippets?.(); }, [reloadSnippets]);

  const persist = async (next: PromptSnippet[]) => {
    if (!saveSnippets) return;
    await saveSnippets(next);
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="w-[28rem] max-h-[80vh] overflow-y-auto rounded-lg bg-zinc-900 border border-zinc-700 p-4 flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-[13px]">设置</h2>
          <button type="button" className={`${SEG} ${OFF}`} onClick={onClose}>完成</button>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">外观</div>
          <div className="flex gap-1.5">
            <button type="button" className={`${SEG} ${theme === "dark" ? ON : OFF}`} onClick={() => onTheme("dark")}>黑夜</button>
            <button type="button" className={`${SEG} ${theme === "light" ? ON : OFF}`} onClick={() => onTheme("light")}>明亮</button>
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">字号</div>
          <div className="flex gap-1.5">
            <button type="button" className={`${SEG} ${fontScale === "normal" ? ON : OFF}`} onClick={() => onFontScale("normal")}>正常</button>
            <button type="button" className={`${SEG} ${fontScale === "large" ? ON : OFF}`} onClick={() => onFontScale("large")}>大</button>
            <button type="button" className={`${SEG} ${fontScale === "xlarge" ? ON : OFF}`} onClick={() => onFontScale("xlarge")}>超大</button>
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">快捷提示词</div>
          {snippetError && <div className="text-red-400 text-sm mb-1.5">{snippetError}</div>}
          {snippets.length === 0 ? (
            <div className="text-[12px] text-zinc-500">还没有快捷提示词，在输入框上方点 + 添加</div>
          ) : (
            <div className="flex flex-col gap-2">
              {snippets.map((s) => (
                <SnippetRow
                  key={s.id}
                  snippet={s}
                  onSave={(next) => persist(snippets.map((row) => row.id === next.id ? next : row))}
                  onDelete={() => persist(snippets.filter((row) => row.id !== s.id))}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
