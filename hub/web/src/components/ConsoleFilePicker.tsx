import { CONSOLE_ACCEPT, displayAttachmentName, isConsoleImage, mergeAttachmentFiles } from "../attachments";
import { UI_META } from "../ui";
import { LocalImageChip } from "./ImageThumb";
import { Button } from "./ui/button";

export function ConsoleFilePicker({
  files,
  onFiles,
  onRejected,
}: {
  files: File[];
  onFiles: (next: File[]) => void;
  onRejected?: () => void;
}) {
  const images = files.map((f, i) => ({ f, i })).filter(({ f }) => isConsoleImage(f));
  const others = files.map((f, i) => ({ f, i })).filter(({ f }) => !isConsoleImage(f));
  return (
    <div className="min-w-0 w-full flex flex-col gap-1.5">
      {images.length > 0 && (
        <ul className="flex min-w-0 w-full flex-wrap gap-2">
          {images.map(({ f, i }) => (
            <li key={`${f.name}-${i}`}>
              <LocalImageChip file={f} onRemove={() => onFiles(files.filter((_, j) => j !== i))} />
            </li>
          ))}
        </ul>
      )}
      <label className="inline-flex w-fit cursor-pointer">
        <Button type="button" variant="outline" size="sm" asChild>
          <span>选择文件</span>
        </Button>
        <input
          type="file"
          accept={CONSOLE_ACCEPT}
          multiple
          className="sr-only"
          onChange={(e) => {
            const picked = [...(e.target.files ?? [])];
            const { files: next, rejected } = mergeAttachmentFiles(files, picked);
            onFiles(next);
            if (rejected) onRejected?.();
            e.target.value = "";
          }}
        />
      </label>
      {others.length > 0 && (
        <ul className={`${UI_META} text-muted-foreground flex min-w-0 w-full flex-col gap-1`}>
          {others.map(({ f, i }) => {
            const name = f.name || "附件";
            return (
              <li key={`${name}-${i}`} className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 flex-1 truncate" title={name}>{displayAttachmentName(name)}</span>
                <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => onFiles(files.filter((_, j) => j !== i))}>
                  移除
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
