import {
  boardTargets, codexComposer, composerFocus, inNormalArea, listWorkspaces, openWorkspace,
  parseChatgptRoot, planCodexMode, planSend, sendButtonName, type ChatgptControl,
} from "./chatgptDesktop";

export type ChatgptPage = {
  controls(): Promise<ChatgptControl[]>;
  pointer(x: number, y: number): Promise<void>;
  clickName(name: string): Promise<void>;
  insertText(text: string): Promise<void>;
  composerText(): Promise<string>;
  close(): void;
};

async function ensureCodex(page: ChatgptPage, controls: ChatgptControl[]): Promise<ChatgptControl[]> {
  const mode = planCodexMode(controls);
  if (!mode) return controls;
  await page.pointer(mode.pointer.x, mode.pointer.y);
  await page.clickName(mode.item);
  const next = await page.controls();
  if (!codexComposer(next)) throw new Error("CHATGPT_MODE_FAILED");
  return next;
}

async function ensureTarget(page: ChatgptPage, controls: ChatgptControl[], project: string | null): Promise<ChatgptControl[]> {
  if (project === null) {
    if (inNormalArea(controls)) return controls;
    let current = controls;
    if (!current.some((control) => control.w > 0 && control.h > 0 && control.name === "不在项目中工作")) {
      const any = listWorkspaces(current).find((item) => item.kind === "project");
      if (!any || any.kind !== "project") throw new Error("CHATGPT_NORMAL_MISSING");
      await page.clickName(openWorkspace(current, any.name).name);
      current = await page.controls();
    }
    await page.clickName(openWorkspace(current, null).name);
    return page.controls();
  }
  await page.clickName(openWorkspace(controls, project).name);
  return page.controls();
}

/** 切到 Codex，打开目标，把文字放进输入框并点发送或排队。输入框里的字还在就算没发出去。 */
export async function prepareAndSend(page: ChatgptPage, root: string, text: string): Promise<void> {
  const target = parseChatgptRoot(root);
  if (!target) throw new Error("CHATGPT_ROOT");
  let controls = await ensureCodex(page, await page.controls());
  controls = await ensureTarget(page, controls, target.project);
  const focus = composerFocus(controls);
  await page.pointer(focus.x, focus.y);
  await page.insertText(text);
  controls = await page.controls();
  planSend(controls, text);
  await page.clickName(sendButtonName(controls));
  const left = (await page.composerText()).trim();
  if (left === text.trim()) throw new Error("CHATGPT_SEND_FAILED");
}

export function targetRoots(controls: ChatgptControl[]): string[] {
  return boardTargets(controls).map((item) => item.root);
}
