import { useState } from "react";
import { groupRuns, cardView, clipCardTitle, COLUMN_LABELS, canArchiveRun, canRetryRun, runDisplayName, cardChromeClass, cardChromeOf, columnHasAlert, unreadAlertDotClass, resumeStallCopy, type ColumnKey, type RunRow } from "../boardState";
import type { Machine } from "../types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Card, CardContent } from "./ui/card";
import { UI_META, UI_TYPE } from "../ui";

const COL_DOT: Record<ColumnKey, string> = {
  waiting: "bg-muted-foreground/70",
  running: "bg-foreground",
  completed: "bg-muted-foreground/50",
  cancelled: "bg-muted-foreground/35",
  error: "bg-destructive",
};

function CardSpinner() {
  return (
    <span
      className="size-3 shrink-0 rounded-full border-[1.5px] border-sky-500/30 border-t-sky-400 animate-spin"
      role="img"
      aria-label="任务执行中"
      title="任务执行中"
    />
  );
}

export default function Board({ runs, selected, onSelect, showArchived, onHide, onUnhide, readMap, onRename, onRetry, quietUnread = false }: {
  runs: RunRow[]; machines: Machine[]; selected: string | null; onSelect: (id: string) => void;
  showArchived: boolean;
  onHide: (id: string) => void;
  onUnhide: (id: string) => void;
  readMap: Record<string, number>;
  onRename: (id: string, title: string) => void;
  onRetry?: (id: string) => void;
  quietUnread?: boolean;
}) {
  const g = groupRuns(runs);
  const now = Date.now();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const startEdit = (r: RunRow) => {
    setDraft(runDisplayName(r));
    setEditingId(r.id);
  };
  const commitEdit = (id: string) => {
    const t = draft.trim();
    setEditingId(null);
    const row = runs.find((x) => x.id === id);
    if (!t || !row || t === runDisplayName(row)) return;
    onRename(id, t);
  };
  return (
    <main className="flex-1 min-h-0 min-w-0 overflow-x-hidden flex gap-3 p-4">
      {(Object.keys(COLUMN_LABELS) as ColumnKey[]).map((col) => (
        <section key={col} className="flex-1 min-w-0 min-h-0 overflow-hidden flex flex-col rounded-2xl bg-muted/30">
          <h2 className={`${UI_TYPE} font-medium tracking-tight text-foreground px-3 pb-2 pt-3 inline-flex items-center gap-1.5 whitespace-nowrap`}>
            <span className={`size-1.5 rounded-full ${COL_DOT[col]}`} />
            {COLUMN_LABELS[col]} <span className={`${UI_META} text-muted-foreground font-normal`}>{g[col].length}</span>
            {columnHasAlert(runs, col, readMap) ? (
              <span className={`size-1.5 shrink-0 rounded-full ${unreadAlertDotClass(quietUnread)}`} data-col-alert={col} title={quietUnread ? "待处理或未读异常（免打扰）" : "待处理或未读异常"} />
            ) : null}
          </h2>
          <div className="flex-1 min-h-0 overflow-x-hidden overflow-y-auto flex flex-col gap-2 px-2 pb-3">
            {g[col].length === 0 && (
              <div className={`${UI_META} text-muted-foreground px-2 py-6 text-center`}>暂无</div>
            )}
            {g[col].map((r) => {
              const v = cardView(r, now);
              const chrome = cardChromeOf(r, readMap[r.id]);
              const editing = editingId === r.id;
              return (
                <Card key={r.id} size="sm" data-state={selected === r.id ? "open" : "closed"} className={`group shrink-0 min-w-0 text-left gap-0 py-0 ring-0 overflow-hidden motion-safe:transition-[border-color,box-shadow] motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] ${cardChromeClass(chrome, selected === r.id)}`}>
                  {editing ? (
                    <CardContent className="px-2.5 py-2">
                      <Input
                        autoFocus
                        className="w-full"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => commitEdit(r.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); commitEdit(r.id); }
                          if (e.key === "Escape") setEditingId(null);
                        }}
                      />
                    </CardContent>
                  ) : (
                    <button onClick={() => onSelect(r.id)} className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 px-3 py-2.5 text-left">
                      <div className={`${UI_TYPE} min-w-0 font-medium leading-snug text-foreground break-words line-clamp-2`} title={v.title}>{clipCardTitle(v.title)}</div>
                      <span className={`inline-flex items-center gap-1 pt-0.5 text-muted-foreground whitespace-nowrap ${UI_META}`}>
                        {col === "running" ? <CardSpinner /> : null}
                        {v.elapsed}
                      </span>
                      {resumeStallCopy(r.end_reason) && (
                        <div className={`${UI_META} col-span-2 text-amber-600 dark:text-amber-400 mt-1 line-clamp-3`}>{resumeStallCopy(r.end_reason)}</div>
                      )}
                      {r.status === "binding" && (
                        <div className={`${UI_META} col-span-2 text-muted-foreground mt-1`}>正在接上这次对话</div>
                      )}
                      {(r.status === "dispatched" || r.status === "created") && (
                        <div className={`${UI_META} col-span-2 text-muted-foreground mt-1`}>已写好，等这台电脑发出</div>
                      )}
                      {r.status === "queued" && (
                        <div className={`${UI_META} col-span-2 text-muted-foreground mt-1`}>排队中</div>
                      )}
                      {r.status === "running" && r.pending_ask ? (
                        <div className={`${UI_META} col-span-2 mt-1 text-muted-foreground`}>待处理</div>
                      ) : null}
                    </button>
                  )}
                  {!editing && (
                    <div className="grid grid-rows-[0fr] opacity-0 motion-safe:transition-[grid-template-rows,opacity] motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:grid-rows-[1fr] group-hover:opacity-100 focus-within:grid-rows-[1fr] focus-within:opacity-100 group-data-[state=open]:grid-rows-[1fr] group-data-[state=open]:opacity-100">
                      <div className="group/actions min-h-0 overflow-hidden">
                        <div className="flex translate-y-1 flex-wrap gap-x-1 px-1.5 pb-1 motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:translate-y-0 group-focus-within/actions:translate-y-0 group-data-[state=open]:translate-y-0">
                          <Button type="button" size="xs" variant="ghost" onClick={(e) => { e.stopPropagation(); startEdit(r); }}>
                            改标题
                          </Button>
                          {showArchived ? (
                            <Button type="button" size="xs" variant="ghost" onClick={(e) => { e.stopPropagation(); onUnhide(r.id); }}>
                              取消隐藏
                            </Button>
                          ) : canArchiveRun(r) ? (
                            <Button type="button" size="xs" variant="ghost" onClick={(e) => { e.stopPropagation(); onHide(r.id); }}>
                              隐藏
                            </Button>
                          ) : null}
                          {onRetry && canRetryRun(r) ? (
                            <Button type="button" size="xs" variant="ghost" onClick={(e) => { e.stopPropagation(); onRetry(r.id); }}>
                              重试
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        </section>
      ))}
    </main>
  );
}
