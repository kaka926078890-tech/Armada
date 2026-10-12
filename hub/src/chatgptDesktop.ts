/** ChatGPT 桌面派发的纯决策。选择器来自 2026-10-12 这台 Mac 的真机控件，不操作 Cursor composer。 */

export type ChatgptControl = {
  name: string;
  kind: "button" | "textbox";
  x: number;
  y: number;
  w: number;
  h: number;
  disabled?: boolean;
};

export type ChatgptWorkspace =
  | { kind: "recent" }
  | { kind: "project"; name: string };

export type NamedClick = { type: "click"; name: string };

export type SendPlan = {
  focus: { name: string; x: number; y: number };
  text: string;
  send: { x: number; y: number };
};

export type StopPlan = { type: "pointer"; x: number; y: number } | { error: "not-ready" };

export type DropPlan = { type: "drop"; x: number; y: number; files: string[] };

export type TurnRead = {
  user: string | null;
  assistant: string | null;
  stopped: boolean;
};

const OPEN_PROJECT = /^在 (.+) 中(?:开始新聊天|新建本地聊天|开启新聊天)$/;

const COMPOSER_NAMES = new Set([
  "询问 ChatGPT",
  "使用 ChatGPT Work",
  "随心输入",
  "与 Codex 协作",
]);

function onScreen(control: ChatgptControl): boolean {
  return control.w > 0 && control.h > 0;
}

function center(control: ChatgptControl): { x: number; y: number } {
  return { x: control.x + control.w / 2, y: control.y + control.h / 2 };
}

function visibleComposer(controls: ChatgptControl[]): ChatgptControl {
  const boxes = controls.filter((control) => {
    if (!onScreen(control) || control.kind !== "textbox") return false;
    return COMPOSER_NAMES.has(control.name) || /^在“/.test(control.name);
  });
  const box = boxes.sort((a, b) => b.w - a.w)[0];
  if (!box) throw new Error("CHATGPT_COMPOSER_MISSING");
  return box;
}

export const CHATGPT_NORMAL_ROOT = "chatgpt:";

export function chatgptProjectRoot(name: string): string {
  return `chatgpt:${name}`;
}

/** 普通区是 null。不是 ChatGPT 目标时返回 null 以外的空。 */
export function parseChatgptRoot(root: string): { project: string | null } | null {
  if (root === CHATGPT_NORMAL_ROOT) return { project: null };
  if (!root.startsWith("chatgpt:")) return null;
  const name = root.slice("chatgpt:".length);
  if (!name || name === "monitor") return null;
  return { project: name };
}

/** 中台列出来的是普通区加上每个已有项目。最近和聊天标题不是目标。 */
export function boardTargets(controls: ChatgptControl[]): { root: string; label: string }[] {
  const projects = listWorkspaces(controls).filter((item) => item.kind === "project");
  return [
    { root: CHATGPT_NORMAL_ROOT, label: "普通区" },
    ...projects.map((item) => ({ root: chatgptProjectRoot(item.name), label: item.name })),
  ];
}

export function codexComposer(controls: ChatgptControl[]): boolean {
  return controls.some((control) => onScreen(control) && (control.name === "随心输入" || control.name === "与 Codex 协作"));
}

export function inNormalArea(controls: ChatgptControl[]): boolean {
  return controls.some((control) => onScreen(control) && control.name === "选择项目");
}

/** 已经在 Codex 输入框时不用再点。否则指针打开模式菜单，再点 Codex 那一项。 */
export function planCodexMode(controls: ChatgptControl[]): { pointer: { x: number; y: number }; item: string } | null {
  if (codexComposer(controls)) return null;
  const buttons = controls.filter((control) => onScreen(control) && control.kind === "button" && control.name.startsWith("切换模式"));
  const button = buttons.find((control) => !control.name.includes("Codex")) ?? buttons[0];
  if (!button) throw new Error("CHATGPT_MODE_MISSING");
  return { pointer: center(button), item: "Codex 构建、调试和发布" };
}

export function composerFocus(controls: ChatgptControl[]): { name: string; x: number; y: number } {
  const box = visibleComposer(controls);
  return { name: box.name, x: box.x + 30, y: box.y + Math.min(16, box.h / 2) };
}

export function sendButtonName(controls: ChatgptControl[]): "排队" | "发送" {
  const queued = controls.some((control) => onScreen(control) && control.name === "排队" && !control.disabled);
  return queued ? "排队" : "发送";
}

export function listWorkspaces(controls: ChatgptControl[]): ChatgptWorkspace[] {
  const projects = controls
    .filter((control) => onScreen(control) && control.kind === "button" && OPEN_PROJECT.test(control.name))
    .map((control) => ({ name: OPEN_PROJECT.exec(control.name)![1], y: control.y }))
    .sort((a, b) => a.y - b.y);
  const out: ChatgptWorkspace[] = [];
  if (controls.some((control) => onScreen(control) && control.name === "最近")) out.push({ kind: "recent" });
  for (const project of projects) out.push({ kind: "project", name: project.name });
  return out;
}

export function openWorkspace(controls: ChatgptControl[], project: string | null): NamedClick {
  if (project === null) {
    const leave = controls.find((control) => onScreen(control) && control.name === "不在项目中工作");
    if (!leave) throw new Error("CHATGPT_NORMAL_MISSING");
    return { type: "click", name: leave.name };
  }
  const opener = controls.find((control) => {
    const match = OPEN_PROJECT.exec(control.name);
    return onScreen(control) && match?.[1] === project;
  });
  if (!opener) throw new Error("CHATGPT_PROJECT_MISSING");
  return { type: "click", name: opener.name };
}

export function planSend(controls: ChatgptControl[], text: string): SendPlan {
  const box = visibleComposer(controls);
  const queued = controls.some((control) => onScreen(control) && control.name === "排队" && !control.disabled);
  const send = controls
    .filter((control) => onScreen(control) && control.name === (queued ? "排队" : "发送") && !control.disabled)
    .sort((a, b) => b.y - a.y)[0];
  if (!send) throw new Error("CHATGPT_SEND_MISSING");
  const point = center(send);
  return {
    focus: { name: box.name, x: box.x + 30, y: box.y + Math.min(16, box.h / 2) },
    text,
    send: point,
  };
}

export function planStop(controls: ChatgptControl[]): StopPlan {
  const stop = controls.find((control) => onScreen(control) && control.name === "停止");
  if (!stop || stop.disabled) return { error: "not-ready" };
  return { type: "pointer", ...center(stop) };
}

export function planAttach(controls: ChatgptControl[], files: string[]): DropPlan {
  const box = visibleComposer(controls);
  return { type: "drop", ...center(box), files: [...files] };
}

export function libraryAddReady(dialogText: string): number {
  const match = dialogText.match(/已选择 (\d+) 个/);
  if (!match) return 0;
  return Number(match[1]);
}

function firstLine(body: string): string | null {
  const line = body
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0 && !/^\d{1,2}:\d{2}$/.test(part));
  return line ?? null;
}

export type RolloutTurn = {
  threadId: string;
  turnId: string;
  user: string | null;
  assistant: string | null;
  completed: boolean;
  /** 用户句写入会话文件的时间。没有时间戳的旧夹具为 null。 */
  at: number | null;
};

type TurnAcc = RolloutTurn;

function turnOf(map: Map<string, TurnAcc>, turnId: string): TurnAcc {
  let turn = map.get(turnId);
  if (!turn) {
    turn = { threadId: "", turnId, user: null, assistant: null, completed: false, at: null };
    map.set(turnId, turn);
  }
  return turn;
}

/** 后台完成后的全文来自 rollout，不来自当前可见页面。 */
export function readRollout(jsonl: string): RolloutTurn[] {
  const map = new Map<string, TurnAcc>();
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: { timestamp?: string; type?: string; payload?: Record<string, unknown> };
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (row.type !== "event_msg" || !row.payload) continue;
    const payload = row.payload;
    const turnId = typeof payload.turn_id === "string" ? payload.turn_id : "";
    if (!turnId) continue;
    const turn = turnOf(map, turnId);
    if (payload.type === "item_completed") {
      const item = payload.item as { type?: string; content?: { type?: string; text?: string }[] } | undefined;
      if (item?.type !== "UserMessage") continue;
      const text = (item.content ?? [])
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n")
        .trim();
      if (text) turn.user = text;
      const at = Date.parse(String(row.timestamp ?? ""));
      if (Number.isFinite(at)) turn.at = at;
      if (typeof payload.thread_id === "string") turn.threadId = payload.thread_id;
    }
    if (payload.type === "task_complete" && typeof payload.last_agent_message === "string") {
      turn.assistant = payload.last_agent_message;
      turn.completed = true;
    }
  }
  return [...map.values()];
}

/** 派发提示词只在恰好一条回合上全等时挂上。两条相同则不猜。早于本次派发的回合不是这一轮。 */
export function matchRolloutTurn(turns: RolloutTurn[], prompt: string, notBefore?: number): RolloutTurn | null {
  const want = prompt.trim();
  const hits = turns.filter((turn) => {
    if ((turn.user ?? "").trim() !== want) return false;
    if (notBefore == null) return true;
    return turn.at != null && turn.at >= notBefore;
  });
  return hits.length === 1 ? hits[0] : null;
}

/** 卡片上的完成后正文。未完成没有回复。 */
export function rolloutCardText(turn: RolloutTurn): string | null {
  if (!turn.completed || turn.assistant == null) return null;
  return turn.assistant;
}

export function readTurn(text: string): TurnRead {
  const userAt = text.indexOf("你说：");
  const assistantAt = text.indexOf("ChatGPT 说：");
  const user = userAt < 0
    ? null
    : firstLine(text.slice(userAt + "你说：".length, assistantAt < 0 ? undefined : assistantAt));
  const assistant = assistantAt < 0 ? null : firstLine(text.slice(assistantAt + "ChatGPT 说：".length));
  return { user, assistant, stopped: text.includes("停止了") };
}
