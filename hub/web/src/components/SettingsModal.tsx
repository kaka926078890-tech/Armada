import { useEffect, useState } from "react";
import type { FontScale, ThemeName } from "../theme";
import { snippetOperatorMessage } from "../promptSnippets";
import type { PromptSnippet } from "../uiPrefs";
import { UI_BTN_DANGER, UI_BTN_GHOST, UI_BTN_PRIMARY, UI_BTN_SEGMENT_OFF, UI_BTN_SEGMENT_ON, UI_INPUT, UI_LABEL, UI_META, UI_OVERLAY, UI_PANEL, UI_TEXTAREA, UI_TYPE } from "../ui";

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
    <div className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
      <label className="flex flex-col gap-1">
        <span className={UI_LABEL}>标题</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className={UI_INPUT}
          aria-label="标题"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className={UI_LABEL}>提示词</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          className={`${UI_TEXTAREA} resize-y`}
          aria-label="提示词"
        />
      </label>
      {error && <div className={`${UI_TYPE} text-red-400`}>{error}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" disabled={busy} className={UI_BTN_DANGER} onClick={() => void run(onDelete)}>删除</button>
        <button type="button" disabled={busy} className={UI_BTN_PRIMARY} onClick={() => void run(() => onSave({ ...snippet, title, body }))}>保存</button>
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
    <div className={UI_OVERLAY} onClick={onClose}>
      <div
        className={`w-[28rem] max-h-[80vh] overflow-y-auto ${UI_PANEL} p-4 flex flex-col gap-4`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className={`font-bold ${UI_TYPE}`}>设置</h2>
          <button type="button" className={UI_BTN_GHOST} onClick={onClose}>完成</button>
        </div>
        <div>
          <div className={`${UI_LABEL} uppercase tracking-wide mb-1.5`}>外观</div>
          <div className="flex gap-1.5">
            <button type="button" className={theme === "dark" ? UI_BTN_SEGMENT_ON : UI_BTN_SEGMENT_OFF} onClick={() => onTheme("dark")}>黑夜</button>
            <button type="button" className={theme === "light" ? UI_BTN_SEGMENT_ON : UI_BTN_SEGMENT_OFF} onClick={() => onTheme("light")}>明亮</button>
          </div>
        </div>
        <div>
          <div className={`${UI_LABEL} uppercase tracking-wide mb-1.5`}>字号</div>
          <div className="flex gap-1.5">
            <button type="button" className={fontScale === "normal" ? UI_BTN_SEGMENT_ON : UI_BTN_SEGMENT_OFF} onClick={() => onFontScale("normal")}>正常</button>
            <button type="button" className={fontScale === "large" ? UI_BTN_SEGMENT_ON : UI_BTN_SEGMENT_OFF} onClick={() => onFontScale("large")}>大</button>
            <button type="button" className={fontScale === "xlarge" ? UI_BTN_SEGMENT_ON : UI_BTN_SEGMENT_OFF} onClick={() => onFontScale("xlarge")}>超大</button>
          </div>
        </div>
        <div>
          <div className={`${UI_LABEL} uppercase tracking-wide mb-1.5`}>快捷提示词</div>
          {snippetError && <div className={`${UI_TYPE} text-red-400 mb-1.5`}>{snippetError}</div>}
          {snippets.length === 0 ? (
            <div className={`${UI_META} text-zinc-500`}>还没有快捷提示词，在输入框上方点添加</div>
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
