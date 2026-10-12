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
  visibleConversation(): Promise<string>;
  clickThread(sidebarThreadId: string): Promise<void>;
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
  let opened = controls;
  try {
    openWorkspace(opened, project);
  } catch {
    await page.clickName(project);
    opened = await page.controls();
  }
  await page.clickName(openWorkspace(opened, project).name);
  return page.controls();
}

/** 切到 Codex，打开目标，把文字放进输入框并点发送或排队。点下去不算成功；会话文件里出现用户句才算发出。 */
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
}

/** 回到已绑定的侧栏线程再发送。已经停在这条会话上就不再点侧栏。 */
export async function prepareFollowup(page: ChatgptPage, sessionId: string, sidebarThreadId: string | null, text: string): Promise<void> {
  if ((await page.visibleConversation()) !== sessionId) {
    if (!sidebarThreadId) throw new Error("CHATGPT_THREAD_MISSING");
    await page.clickThread(sidebarThreadId);
    if ((await page.visibleConversation()) !== sessionId) throw new Error("CHATGPT_THREAD_MISSING");
  }
  let controls = await ensureCodex(page, await page.controls());
  const focus = composerFocus(controls);
  await page.pointer(focus.x, focus.y);
  await page.insertText(text);
  controls = await page.controls();
  planSend(controls, text);
  await page.clickName(sendButtonName(controls));
}

export function targetRoots(controls: ChatgptControl[]): string[] {
  return boardTargets(controls).map((item) => item.root);
}
