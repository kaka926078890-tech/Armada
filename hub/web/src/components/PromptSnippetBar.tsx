import { useState } from "react";
import { snippetOperatorMessage } from "../promptSnippets";
import type { PromptSnippet } from "../uiPrefs";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { UI_LABEL, UI_META, UI_TYPE } from "../ui";

const TITLE_MAX = 40;
const BODY_MAX = 8000;

export function AddSnippetDialog({
  title, body, error, saving, onTitle, onBody, onCancel, onSave,
  heading = "添加快捷提示词",
  lead = "标题会出现在输入框上方，点它会把提示词追加到末尾。",
}: {
  title: string;
  body: string;
  error: string;
  saving: boolean;
  onTitle: (value: string) => void;
  onBody: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
  heading?: string;
  lead?: string;
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent
        className="sm:max-w-md gap-4"
        showCloseButton={false}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
      >
        <DialogHeader>
          <DialogTitle id="add-snippet-title" className={`${UI_TYPE} font-sans leading-snug`}>{heading}</DialogTitle>
          <p className={`mt-1 ${UI_META} leading-relaxed text-muted-foreground`}>{lead}</p>
        </DialogHeader>
        <label className="flex flex-col gap-1.5">
          <span className={UI_LABEL}>标题</span>
          <Input
            autoFocus
            value={title}
            maxLength={TITLE_MAX}
            placeholder="例如：代码审查"
            onChange={(e) => onTitle(e.target.value)}
          />
          <span className={`self-end ${UI_META} text-muted-foreground`}>{title.length}/{TITLE_MAX}</span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={UI_LABEL}>提示词</span>
          <Textarea
            value={body}
            maxLength={BODY_MAX}
            rows={6}
            placeholder="点标题后追加到输入框末尾的正文"
            onChange={(e) => onBody(e.target.value)}
            className="resize-y min-h-[8rem]"
          />
          <span className={`self-end ${UI_META} text-muted-foreground`}>{body.length}/{BODY_MAX}</span>
        </label>
        {error && <div className={`${UI_TYPE} text-destructive`}>{error}</div>}
        <DialogFooter className="mx-0 mb-0">
          <Button type="button" variant="outline" onClick={onCancel}>取消</Button>
          <Button type="button" disabled={saving} onClick={onSave}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
          <Button key={s.id} type="button" size="sm" variant="outline" className="rounded-full" onClick={() => onAppend(s.body)}>
            {s.title}
          </Button>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="rounded-full border-dashed"
          aria-label="添加快捷提示词"
          title={atLimit ? "最多 30 条" : "添加快捷提示词"}
          disabled={atLimit}
          onClick={() => { if (!atLimit) { setAdding(true); setError(""); } }}
        >
          添加
        </Button>
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
