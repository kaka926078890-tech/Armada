import { useState } from "react";
import { snippetOperatorMessage } from "../promptSnippets";
import type { PromptSnippet } from "../uiPrefs";

const CHIP = "h-7 px-2.5 rounded-md border border-zinc-700/80 bg-zinc-900/70 text-[12px] text-zinc-300 hover:text-zinc-100 hover:border-zinc-500 hover:bg-zinc-800 whitespace-nowrap";
const ADD = "h-7 px-2.5 rounded-md border border-dashed border-zinc-600 text-[12px] text-zinc-400 hover:text-zinc-100 hover:border-zinc-400 hover:bg-zinc-800 disabled:opacity-40 disabled:hover:text-zinc-400";
const FIELD = "w-full rounded-md bg-zinc-950 border border-zinc-700 px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-sky-500";
const TITLE_MAX = 40;
const BODY_MAX = 8000;

export function AddSnippetDialog({
  title, body, error, saving, onTitle, onBody, onCancel, onSave,
}: {
  title: string;
  body: string;
  error: string;
  saving: boolean;
  onTitle: (value: string) => void;
  onBody: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
      onClick={(e) => { e.stopPropagation(); onCancel(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-snippet-title"
        className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl p-5 flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
      >
        <div>
          <h3 id="add-snippet-title" className="text-[15px] font-semibold text-zinc-100">添加快捷提示词</h3>
          <p className="mt-1 text-[12px] leading-relaxed text-zinc-500">标题会出现在输入框上方，点它会把提示词追加到末尾。</p>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-zinc-400">标题</span>
          <input
            autoFocus
            value={title}
            maxLength={TITLE_MAX}
            placeholder="例如：代码审查"
            onChange={(e) => onTitle(e.target.value)}
            className={`${FIELD} h-9 py-0`}
          />
          <span className="self-end text-[11px] text-zinc-600">{title.length}/{TITLE_MAX}</span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-zinc-400">提示词</span>
          <textarea
            value={body}
            maxLength={BODY_MAX}
            rows={6}
            placeholder="点标题后追加到输入框末尾的正文"
            onChange={(e) => onBody(e.target.value)}
            className={`${FIELD} resize-y min-h-[8rem] leading-relaxed`}
          />
          <span className="self-end text-[11px] text-zinc-600">{body.length}/{BODY_MAX}</span>
        </label>
        {error && <div className="text-red-400 text-sm">{error}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            className="h-8 px-3 rounded-md text-[13px] text-zinc-300 hover:bg-zinc-800"
            onClick={onCancel}
          >
            取消
          </button>
          <button
            type="button"
            disabled={saving}
            className="h-8 px-3 rounded-md text-[13px] bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-40"
            onClick={onSave}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function PromptSnippetBar({
  snippets, onAppend, onAdd,
}: {
  snippets: PromptSnippet[];
  onAppend: (body: string) => void;
  onAdd: (title: string, body: string) => Promise<void> | void;
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const atLimit = snippets.length >= 30;

  const resetForm = () => {
    setAdding(false);
    setTitle("");
    setBody("");
    setError("");
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await onAdd(title, body);
      resetForm();
    } catch (e) {
      setError(snippetOperatorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5 items-center">
        {snippets.map((s) => (
          <button key={s.id} type="button" className={CHIP} onClick={() => onAppend(s.body)}>
            {s.title}
          </button>
        ))}
        <button
          type="button"
          className={ADD}
          aria-label="添加快捷提示词"
          title={atLimit ? "最多 30 条" : "添加快捷提示词"}
          disabled={atLimit}
          onClick={() => { if (!atLimit) { setAdding(true); setError(""); } }}
        >
          添加
        </button>
      </div>
      {adding && (
        <AddSnippetDialog
          title={title}
          body={body}
          error={error}
          saving={saving}
          onTitle={setTitle}
          onBody={setBody}
          onCancel={resetForm}
          onSave={() => { void save(); }}
        />
      )}
    </div>
  );
}
