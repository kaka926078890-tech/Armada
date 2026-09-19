/** One density scale for hub chrome. Primary controls are 32×13; snippet chips are the only 28px exception. */

export const UI_TYPE = "text-[13px]";
export const UI_BODY = "text-[14px]";
export const UI_META = "text-[12px]";
export const UI_LABEL = "text-[12px] font-medium text-zinc-500";

export const UI_BTN =
  "inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-lg text-[13px] font-medium whitespace-nowrap disabled:opacity-40";
export const UI_BTN_PRIMARY = `${UI_BTN} bg-sky-600 hover:bg-sky-500 text-white`;
export const UI_BTN_ACCENT = `${UI_BTN} bg-sky-800 hover:bg-sky-700 text-sky-100`;
export const UI_BTN_GHOST = `${UI_BTN} border border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100`;
export const UI_BTN_GHOST_ACTIVE = `${UI_BTN} border border-amber-800 bg-amber-900/60 text-amber-200`;
export const UI_BTN_QUIET = `${UI_BTN} text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800`;
export const UI_BTN_DANGER = `${UI_BTN} text-red-300 hover:bg-red-950/40`;
export const UI_BTN_DANGER_FILL = `${UI_BTN} bg-red-950/80 hover:bg-red-900 text-red-200`;
export const UI_BTN_SEGMENT_ON = `${UI_BTN} border border-sky-600 bg-sky-900/40 text-zinc-100`;
export const UI_BTN_SEGMENT_OFF = `${UI_BTN} border border-zinc-700 text-zinc-400 hover:text-zinc-100`;

export const UI_INPUT =
  "h-8 px-3 rounded-lg bg-zinc-950 border border-zinc-700 text-[13px] outline-none focus:border-sky-500";
export const UI_SELECT =
  "h-8 px-3 rounded-lg bg-zinc-950 border border-zinc-700 text-[13px] outline-none focus:border-sky-500";
export const UI_TEXTAREA =
  "px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-700 text-[13px] leading-relaxed outline-none focus:border-sky-500";
export const UI_TEXTAREA_INSET =
  "px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-[13px] leading-relaxed outline-none focus:border-sky-500 placeholder:text-zinc-600";

export const UI_CHIP =
  "h-7 px-2.5 rounded-full border border-zinc-700/80 bg-zinc-900/70 text-[12px] text-zinc-300 hover:text-zinc-100 hover:border-zinc-500 hover:bg-zinc-800 whitespace-nowrap";
export const UI_CHIP_ACCENT =
  "h-7 px-2.5 rounded-full border border-sky-800 bg-sky-800 text-[12px] text-sky-100 hover:bg-sky-700 hover:text-sky-50 whitespace-nowrap";
export const UI_CHIP_ADD =
  "h-7 px-2.5 rounded-full border border-dashed border-zinc-600 text-[12px] text-zinc-400 hover:text-zinc-100 hover:border-zinc-400 hover:bg-zinc-800 disabled:opacity-40";

export const UI_OPTION =
  "w-full min-h-8 px-3 py-1.5 rounded-lg border text-left text-[13px] text-zinc-200 disabled:opacity-70";
export const UI_OPTION_ON = `${UI_OPTION} border-[#599CE7] bg-[#599CE7]/10`;
export const UI_OPTION_OFF = `${UI_OPTION} border-zinc-800 hover:border-zinc-700 bg-zinc-950/40`;

export const ASK_CONTINUE_BTN = `${UI_BTN} bg-[#599CE7] text-white hover:bg-[#7aafeb]`;
export const ASK_PLAN_BTN = `${UI_BTN} bg-[#F1B467] text-[#1a1a1a] hover:bg-[#f6c57e]`;
export const ASK_SKIP_BTN = `${UI_BTN} bg-zinc-800 hover:bg-zinc-700 text-zinc-200`;

export const UI_PANEL = "rounded-xl border border-zinc-800 bg-zinc-900";
export const UI_OVERLAY = "fixed inset-0 z-50 flex items-center justify-center bg-black/60";
