import { useState } from "react";
import { snippetOperatorMessage } from "../promptSnippets";
import type { PromptSnippet } from "../uiPrefs";
import { UI_BTN_GHOST, UI_BTN_PRIMARY, UI_CHIP, UI_CHIP_ADD, UI_INPUT, UI_LABEL, UI_META, UI_OVERLAY, UI_PANEL, UI_TEXTAREA } from "../ui";

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
      className={`${UI_OVERLAY} z-[60] p-4`}
      onClick={(e) => { e.stopPropagation(); onCancel(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-snippet-title"
        className={`w-full max-w-md ${UI_PANEL} shadow-2xl p-5 flex flex-col gap-4`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
      >
        <div>
          <h3 id="add-snippet-title" className="text-[15px] font-semibold text-zinc-100">添加快捷提示词</h3>
          <p className={`mt-1 ${UI_META} leading-relaxed text-zinc-500`}>标题会出现在输入框上方，点它会把提示词追加到末尾。</p>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className={UI_LABEL}>标题</span>
          <input
            autoFocus
            value={title}
            maxLength={TITLE_MAX}
            placeholder="例如：代码审查"
            onChange={(e) => onTitle(e.target.value)}
            className={`w-full ${UI_INPUT}`}
          />
          <span className={`self-end ${UI_META} text-zinc-600`}>{title.length}/{TITLE_MAX}</span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={UI_LABEL}>提示词</span>
          <textarea
            value={body}
            maxLength={BODY_MAX}
            rows={6}
            placeholder="点标题后追加到输入框末尾的正文"
            onChange={(e) => onBody(e.target.value)}
            className={`w-full ${UI_TEXTAREA} resize-y min-h-[8rem]`}
          />
          <span className={`self-end ${UI_META} text-zinc-600`}>{body.length}/{BODY_MAX}</span>
        </label>
        {error && <div className="text-red-400 text-sm">{error}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            className={UI_BTN_GHOST}
            onClick={onCancel}
          >
            取消
          </button>
          <button
            type="button"
            disabled={saving}
            className={UI_BTN_PRIMARY}
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
          <button key={s.id} type="button" className={UI_CHIP} onClick={() => onAppend(s.body)}>
            {s.title}
          </button>
        ))}
        <button
          type="button"
          className={UI_CHIP_ADD}
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
