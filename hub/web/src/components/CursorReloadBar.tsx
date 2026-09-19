import { Button } from "./ui/button";
import { UI_META, UI_TYPE } from "../ui";

export default function CursorReloadBar({
  needed, vsix, onNow, onIdle, onSkip,
}: {
  needed: boolean;
  vsix?: string;
  onNow: () => void;
  onIdle: () => void;
  onSkip: () => void;
}) {
  if (!needed) return null;
  return (
    <div className={`px-4 py-1.5 ${UI_TYPE} bg-amber-500/10 border-b border-amber-500/20 flex flex-wrap items-center gap-2`}>
      <span className="text-amber-800 dark:text-amber-200">
        本机 Cursor 扩展已更新{vsix ? `（${vsix}）` : ""}，需 Reload Window
      </span>
      <span className={`${UI_META} text-muted-foreground`}>空闲后自动会等本窗口 Armada 任务结束；现在 Reload 立刻重载。按钮会下发到在线 Cursor（含远程机）。</span>
      <span className="ml-auto flex flex-wrap gap-1">
        <Button type="button" size="sm" onClick={onNow}>现在 Reload</Button>
        <Button type="button" size="sm" variant="outline" onClick={onIdle}>空闲后自动</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onSkip}>这次跳过</Button>
      </span>
    </div>
  );
}
