import { useState } from "react";
import { snippetOperatorMessage } from "../promptSnippets";
import type { PromptSnippet } from "../uiPrefs";

const CHIP = "px-2 py-0.5 rounded-full border border-zinc-700 text-[12px] text-zinc-300 hover:text-zinc-100 hover:border-zinc-500 whitespace-nowrap";
const PLUS = "px-2 py-0.5 rounded-full border border-zinc-600 text-[13px] leading-none text-zinc-300 hover:text-zinc-100 hover:border-zinc-400 disabled:opacity-40 disabled:hover:text-zinc-300";

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
          className={PLUS}
          aria-label="添加快捷提示词"
          title={atLimit ? "最多 30 条" : "添加快捷提示词"}
          disabled={atLimit}
          onClick={() => { if (!atLimit) { setAdding(true); setError(""); } }}
        >
          +
        </button>
      </div>
      {adding && (
        <div className="flex flex-col gap-2 rounded border border-zinc-800 bg-zinc-950 p-2">
          <label className="flex flex-col gap-1 text-[12px] text-zinc-400">
            标题
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-[13px] text-zinc-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-zinc-400">
            提示词
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              className="px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-[13px] text-zinc-100 resize-y"
            />
          </label>
          {error && <div className="text-red-400 text-sm">{error}</div>}
          <div className="flex justify-end gap-2">
            <button type="button" className="px-2 py-1 rounded bg-zinc-800 text-[12px]" onClick={resetForm}>取消</button>
            <button type="button" disabled={saving} className="px-2 py-1 rounded bg-sky-700 hover:bg-sky-600 text-[12px] disabled:opacity-40" onClick={() => void save()}>保存</button>
          </div>
        </div>
      )}
    </div>
  );
}
