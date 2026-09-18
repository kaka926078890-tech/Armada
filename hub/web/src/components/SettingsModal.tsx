import type { FontScale, ThemeName } from "../theme";

const SEG = "px-2 py-0.5 rounded border text-[12px]";
const ON = "border-sky-600 bg-sky-900/40 text-zinc-100";
const OFF = "border-zinc-700 text-zinc-400 hover:text-zinc-100";

export default function SettingsModal({
  theme, fontScale, onTheme, onFontScale, onClose,
}: {
  theme: ThemeName;
  fontScale: FontScale;
  onTheme: (theme: ThemeName) => void;
  onFontScale: (scale: FontScale) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="w-[22rem] rounded-lg bg-zinc-900 border border-zinc-700 p-4 flex flex-col gap-4"
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
      </div>
    </div>
  );
}
