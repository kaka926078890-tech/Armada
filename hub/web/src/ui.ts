/** Type scale only. Chrome density lives on shadcn primitives in `components/ui`. */

export const UI_TYPE = "text-[13px]";
export const UI_BODY = "text-[14px]";
export const UI_META = "text-[12px]";
export const UI_LABEL = "text-[12px] font-medium text-muted-foreground";

/** Ask option rows need min-height (multi-line), not the Button h-8 cap. */
export const UI_OPTION =
  "w-full min-h-8 px-3 py-1.5 rounded-lg border text-left text-[13px] text-foreground disabled:opacity-70";
export const UI_OPTION_ON = `${UI_OPTION} border-primary bg-primary/10`;
export const UI_OPTION_OFF = `${UI_OPTION} border-border hover:border-input bg-card/40`;
