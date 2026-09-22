import { useEffect, useState } from "react";
import type { FontScale, ThemeName } from "../theme";
import { snippetOperatorMessage } from "../promptSnippets";
import type { PromptSnippet } from "../uiPrefs";
import { AddSnippetDialog } from "./PromptSnippetBar";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { UI_LABEL, UI_META, UI_TYPE } from "../ui";

const EDIT_LEAD = "保存后，输入框上方的标签和追加正文会一起更新。";

export default function SettingsModal({
  theme, fontScale, onTheme, onFontScale, onClose,
  snippets = [], saveSnippets, reloadSnippets, snippetError = "",
  quietUnread = false, onQuietUnread, canMarkAllRead = false, onMarkAllRead,
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
  quietUnread?: boolean;
  onQuietUnread?: (next: boolean) => void;
  canMarkAllRead?: boolean;
  onMarkAllRead?: () => void;
}) {
  const [editing, setEditing] = useState<PromptSnippet | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [editError, setEditError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { reloadSnippets?.(); }, [reloadSnippets]);

  const persist = async (next: PromptSnippet[]) => {
    if (!saveSnippets) return;
    await saveSnippets(next);
  };

  const openEdit = (snippet: PromptSnippet) => {
    if (busy) return;
    setEditing(snippet);
    setTitle(snippet.title);
    setBody(snippet.body);
    setEditError("");
  };

  const remove = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setActionError("");
    try {
      await persist(snippets.filter((row) => row.id !== id));
    } catch (e) {
      setActionError(snippetOperatorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!editing || busy) return;
    setBusy(true);
    setEditError("");
    try {
      await persist(snippets.map((row) => row.id === editing.id ? { ...row, title, body } : row));
      setEditing(null);
    } catch (e) {
      setEditError(snippetOperatorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !editing) onClose(); }}>
      <DialogContent
        className="sm:max-w-[28rem] max-h-[80vh] overflow-y-auto gap-4"
        showCloseButton={false}
        onClick={(e) => e.stopPropagation()}
        onPointerDownOutside={(e) => { if (editing) e.preventDefault(); }}
        onInteractOutside={(e) => { if (editing) e.preventDefault(); }}
        onEscapeKeyDown={(e) => { if (editing) e.preventDefault(); }}
      >
        <DialogHeader className="flex-row items-center justify-between">
          <DialogTitle className={UI_TYPE}>设置</DialogTitle>
          <Button type="button" variant="outline" onClick={onClose}>完成</Button>
        </DialogHeader>
        <div>
          <div className={`${UI_LABEL} uppercase tracking-wide mb-1.5`}>外观</div>
          <div className="flex gap-1.5">
            <Button type="button" variant={theme === "dark" ? "secondary" : "outline"} onClick={() => onTheme("dark")}>黑夜</Button>
            <Button type="button" variant={theme === "light" ? "secondary" : "outline"} onClick={() => onTheme("light")}>明亮</Button>
          </div>
        </div>
        <div>
          <div className={`${UI_LABEL} uppercase tracking-wide mb-1.5`}>字号</div>
          <div className="flex gap-1.5">
            <Button type="button" variant={fontScale === "normal" ? "secondary" : "outline"} onClick={() => onFontScale("normal")}>正常</Button>
            <Button type="button" variant={fontScale === "large" ? "secondary" : "outline"} onClick={() => onFontScale("large")}>大</Button>
            <Button type="button" variant={fontScale === "xlarge" ? "secondary" : "outline"} onClick={() => onFontScale("xlarge")}>超大</Button>
          </div>
        </div>
        <div>
          <div className={`${UI_LABEL} uppercase tracking-wide mb-1.5`}>消息</div>
          <div className="flex flex-col gap-2">
            <Button
              type="button"
              variant={quietUnread ? "secondary" : "outline"}
              aria-pressed={quietUnread}
              onClick={() => onQuietUnread?.(!quietUnread)}
            >
              消息免打扰
            </Button>
            <p className={`${UI_META} text-muted-foreground`}>开启后，未读红点改为灰点，未读数量仍在。</p>
            <Button type="button" variant="outline" disabled={!canMarkAllRead} onClick={() => onMarkAllRead?.()}>
              清除所有已读
            </Button>
          </div>
        </div>
        <div>
          <div className={`${UI_LABEL} uppercase tracking-wide mb-1.5`}>快捷提示词</div>
          {snippetError && <div className={`${UI_TYPE} text-destructive mb-1.5`}>{snippetError}</div>}
          {actionError && <div className={`${UI_TYPE} text-destructive mb-1.5`}>{actionError}</div>}
          {snippets.length === 0 ? (
            <div className={`${UI_META} text-muted-foreground`}>还没有快捷提示词，在输入框上方点添加</div>
          ) : (
            <div className="flex flex-wrap gap-1.5 items-center pt-1 pr-1">
              {snippets.map((s) => (
                <span key={s.id} className="relative inline-flex">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="rounded-full"
                    onClick={() => openEdit(s)}
                  >
                    {s.title}
                  </Button>
                  <button
                    type="button"
                    aria-label={`删除 ${s.title}`}
                    title="删除"
                    disabled={busy}
                    className="absolute -top-1 -right-1 z-10 flex size-4 items-center justify-center rounded-full border border-border bg-background text-[11px] leading-none text-muted-foreground hover:text-destructive disabled:opacity-50"
                    onClick={() => { void remove(s.id); }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {editing && (
            <AddSnippetDialog
              heading="编辑快捷提示词"
              lead={EDIT_LEAD}
              title={title}
              body={body}
              error={editError}
              saving={busy}
              onTitle={setTitle}
              onBody={setBody}
              onCancel={() => { if (!busy) setEditing(null); }}
              onSave={() => { void saveEdit(); }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
