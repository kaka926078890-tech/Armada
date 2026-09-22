import { useEffect, useState } from "react";
import type { FontScale, ThemeName } from "../theme";
import { snippetOperatorMessage } from "../promptSnippets";
import type { PromptSnippet } from "../uiPrefs";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { UI_LABEL, UI_META, UI_TYPE } from "../ui";

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
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card/60 p-3">
      <label className="flex flex-col gap-1">
        <span className={UI_LABEL}>标题</span>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="标题"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className={UI_LABEL}>提示词</span>
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          className="resize-y"
          aria-label="提示词"
        />
      </label>
      {error && <div className={`${UI_TYPE} text-destructive`}>{error}</div>}
      <div className="flex justify-end gap-2">
        <Button type="button" disabled={busy} variant="destructive" onClick={() => void run(onDelete)}>删除</Button>
        <Button type="button" disabled={busy} onClick={() => void run(() => onSave({ ...snippet, title, body }))}>保存</Button>
      </div>
    </div>
  );
}

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
  useEffect(() => { reloadSnippets?.(); }, [reloadSnippets]);

  const persist = async (next: PromptSnippet[]) => {
    if (!saveSnippets) return;
    await saveSnippets(next);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-[28rem] max-h-[80vh] overflow-y-auto gap-4" showCloseButton={false} onClick={(e) => e.stopPropagation()}>
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
          {snippets.length === 0 ? (
            <div className={`${UI_META} text-muted-foreground`}>还没有快捷提示词，在输入框上方点添加</div>
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
      </DialogContent>
    </Dialog>
  );
}
