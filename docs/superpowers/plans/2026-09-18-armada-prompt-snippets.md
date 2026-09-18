# 快捷提示词 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-09-18-armada-prompt-snippets-design.md`

**Goal:** 中台派发/续聊输入框上方与 App 派发/续聊 sheet 共用一份 hub 权威快捷提示词：点标题追加到输入框末尾，`+` 添加，设置页改/删。

**Architecture:** `promptSnippets` 存在 `ui-prefs.json`。客户端只打 `GET/PUT /api/prompt-snippets` 与 `/mobile/prompt-snippets`。中转 `cmd.promptSnippetsGet|Put`。不进 `RunSnap`。App 禁止碰 `/api/ui-prefs`。

**Tech Stack:** bun, Hono, React, SwiftUI, Jetpack Compose.

## Global Constraints

- Armada 主干 `master`；工作目录 `/Users/apple/Desktop/desk/armada`。不要开 `feat/*`。
- 测不红不准改生产（先红测再实现）。
- 不改 `runToSnap` 字段、ingest、stop、CDP、`decideStop`、外观倍率。
- App 源码不得出现 `/api/ui-prefs` 或 `/mobile/ui-prefs`。
- 错误码：`SNIPPET_INVALID` / `SNIPPET_LIMIT` / `READ_FAIL` / `WRITE_FAIL`。禁止用现网 `INVALID`（文案是「推送登记失败」）。
- PUT 整表、上限 30、title 1–40、body 1–8000、id `/^[a-z0-9-]{8,64}$/`。
- 插入：`appendSnippetBody`；点胶囊不发送。
- 删除/编辑只在设置；胶囊只有插入和 `+`。
- `relayClient.ts` 与 `relayAttach.ts` 必须同步加 cmd。
- `putUiPrefs` 调用不得带 `promptSnippets`。
- 每任务结束：`git add` 本任务文件并 commit；**不要 push**（controller 最后推 `origin/master`）。
- 提交说明用现仓风格（中文/英文短句均可）；不要 `--no-verify`、不要 force push。
- 打包 overlay 验收（规格 A9）由 controller 在全部任务后做，本计划任务不跑 `tauri build`。

## Files

| File | Role |
| --- | --- |
| `hub/src/uiPrefs.ts` | 类型、`normalizePromptSnippets`、`assertPromptSnippets`、`fillSnippetIds`、merge known |
| `hub/web/src/uiPrefs.ts` | 镜像类型 + defaults；LS 不算 snippets |
| `hub/src/index.ts` | `GET/PUT /api/prompt-snippets` |
| `hub/web/src/promptSnippets.ts` | `appendSnippetBody` |
| `hub/web/src/api.ts` | `getPromptSnippets` / `putPromptSnippets` |
| `hub/web/src/components/PromptSnippetBar.tsx` | 胶囊 + `+` 对话框 |
| `hub/web/src/components/{Modals,RunDetail,SettingsModal}.tsx` | 挂条 / 设置管理 |
| `hub/web/src/App.tsx` | App 级 snippets state |
| `hub/src/relayClient.ts` / `relayAttach.ts` | 两条 cmd |
| `relay/src/server.ts` | `/mobile/prompt-snippets`、`waitHub.snippets`、`hubCmdStatus` |
| `mobile/ios/ArmadaRemote/{RelayAPI,Screens,ArmadaRemoteApp}.swift` | API + UI |
| `mobile/android/.../{RelayClient,OperatorMessages,SessionVm,MainActivity}.kt` | 同上 |

---

### Task 1: UiPrefs 字段 + 归一化

**Files:**
- Modify: `hub/src/uiPrefs.ts`
- Modify: `hub/web/src/uiPrefs.ts`
- Test: `hub/test/uiPrefs.test.ts`
- Test: `hub/web/test/uiPrefs.test.ts`（defaults 展开仍编译；`localDiffersFromDefaults` 不因空词库为 true）

**Interfaces:**
- Produces:
```ts
export type PromptSnippet = { id: string; title: string; body: string };
export const SNIPPET_MAX = 30;
export const SNIPPET_TITLE_MAX = 40;
export const SNIPPET_BODY_MAX = 8000;
export const SNIPPET_ID_RE = /^[a-z0-9-]{8,64}$/;
export function normalizePromptSnippets(raw: unknown): PromptSnippet[];
export function assertPromptSnippets(raw: unknown):
  { ok: true; snippets: Array<{ id?: string; title: string; body: string }> } |
  { ok: false; error: "SNIPPET_INVALID" | "SNIPPET_LIMIT" };
export function fillSnippetIds(items: Array<{ id?: string; title: string; body: string }>): PromptSnippet[];
```

- [ ] **Step 1: Write the failing tests** in `hub/test/uiPrefs.test.ts`

```ts
test("defaults include empty promptSnippets", () => {
  expect(UI_PREFS_DEFAULTS.promptSnippets).toEqual([]);
  expect(normalizeUiPrefs({}).promptSnippets).toEqual([]);
});

test("read path drops illegal snippets and keeps first 30", () => {
  const n = normalizeUiPrefs({
    promptSnippets: [
      { id: "bad", title: "x", body: "y" },
      { id: "ok-id-01", title: "t", body: "b" },
      { id: "ok-id-02", title: "", body: "b" },
    ],
  });
  expect(n.promptSnippets).toEqual([{ id: "ok-id-01", title: "t", body: "b" }]);
});

test("merge promptSnippets keeps theme", () => {
  const base = { ...UI_PREFS_DEFAULTS, theme: "light" as const };
  const next = mergeUiPrefs(base, { promptSnippets: [{ id: "ok-id-01", title: "t", body: "b" }] });
  expect(next.theme).toBe("light");
  expect(next.promptSnippets).toHaveLength(1);
});

test("assert rejects over 30, empty title, duplicate ids, empty id", () => {
  expect(assertPromptSnippets("x").ok).toBe(false);
  if (!assertPromptSnippets("x").ok) expect(assertPromptSnippets("x").error).toBe("SNIPPET_INVALID");
  const tooMany = Array.from({ length: 31 }, (_, i) => ({
    id: `id-${String(i).padStart(6, "0")}`, title: "t", body: "b",
  }));
  const lim = assertPromptSnippets(tooMany);
  expect(lim.ok).toBe(false);
  if (!lim.ok) expect(lim.error).toBe("SNIPPET_LIMIT");
  expect(assertPromptSnippets([{ title: "  ", body: "b" }]).ok).toBe(false);
  expect(assertPromptSnippets([
    { id: "ok-id-01", title: "a", body: "b" },
    { id: "ok-id-01", title: "c", body: "d" },
  ]).ok).toBe(false);
  expect(assertPromptSnippets([{ id: "", title: "a", body: "b" }]).ok).toBe(false);
});

test("assert allows omitted id; fillSnippetIds assigns uuid", () => {
  const a = assertPromptSnippets([{ title: "a", body: "b" }]);
  expect(a.ok).toBe(true);
  if (!a.ok) return;
  const filled = fillSnippetIds(a.snippets);
  expect(filled[0]!.id).toMatch(SNIPPET_ID_RE);
  expect(filled[0]!.title).toBe("a");
});
```

Also update existing `clamps illegal theme` expectation: it `toEqual({ ...UI_PREFS_DEFAULTS, ...})` — after adding the field this still works if defaults include `promptSnippets: []`.

`hub/web/src/uiPrefs.ts`: add `promptSnippets: PromptSnippet[]` to type + defaults; `loadLocalUiPrefsMirror` 返回 `promptSnippets: []`（不要读 LS）；`localDiffersFromDefaults` **不要**因 `promptSnippets` 返回 true。

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test hub/test/uiPrefs.test.ts`
Expected: FAIL — `promptSnippets` undefined / `assertPromptSnippets` not exported.

- [ ] **Step 3: Minimal implementation** in `hub/src/uiPrefs.ts`

```ts
export type PromptSnippet = { id: string; title: string; body: string };
export const SNIPPET_MAX = 30;
export const SNIPPET_TITLE_MAX = 40;
export const SNIPPET_BODY_MAX = 8000;
export const SNIPPET_ID_RE = /^[a-z0-9-]{8,64}$/;

function asSnippetItem(raw: unknown): { id?: string; title: string; body: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.title !== "string" || typeof o.body !== "string") return null;
  const title = o.title.trim();
  const body = o.body.trim();
  if (title.length < 1 || title.length > SNIPPET_TITLE_MAX) return null;
  if (body.length < 1 || body.length > SNIPPET_BODY_MAX) return null;
  if (o.id === undefined || o.id === null) return { title, body };
  if (typeof o.id !== "string" || !SNIPPET_ID_RE.test(o.id)) return null;
  return { id: o.id, title, body };
}

export function normalizePromptSnippets(raw: unknown): PromptSnippet[] {
  if (!Array.isArray(raw)) return [];
  const out: PromptSnippet[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const s = asSnippetItem(item);
    if (!s?.id || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push({ id: s.id, title: s.title, body: s.body });
    if (out.length >= SNIPPET_MAX) break;
  }
  return out;
}

export function assertPromptSnippets(raw: unknown):
  { ok: true; snippets: Array<{ id?: string; title: string; body: string }> } |
  { ok: false; error: "SNIPPET_INVALID" | "SNIPPET_LIMIT" } {
  if (!Array.isArray(raw)) return { ok: false, error: "SNIPPET_INVALID" };
  if (raw.length > SNIPPET_MAX) return { ok: false, error: "SNIPPET_LIMIT" };
  const snippets: Array<{ id?: string; title: string; body: string }> = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const s = asSnippetItem(item);
    if (!s) return { ok: false, error: "SNIPPET_INVALID" };
    if (s.id) {
      if (seen.has(s.id)) return { ok: false, error: "SNIPPET_INVALID" };
      seen.add(s.id);
    }
    snippets.push(s);
  }
  return { ok: true, snippets };
}

export function fillSnippetIds(items: Array<{ id?: string; title: string; body: string }>): PromptSnippet[] {
  return items.map((s) => ({
    id: s.id && SNIPPET_ID_RE.test(s.id) ? s.id : crypto.randomUUID(),
    title: s.title,
    body: s.body,
  }));
}
```

- `UiPrefs` 加 `promptSnippets: PromptSnippet[]`
- `UI_PREFS_DEFAULTS.promptSnippets = []`
- `normalizeUiPrefs` 返回 `promptSnippets: normalizePromptSnippets(o.promptSnippets)`
- `mergeUiPrefs` known 加入 `"promptSnippets"`

web 镜像：同样加类型与 defaults；`loadLocalUiPrefsMirror` 的 return 对象必须带 `promptSnippets: []`（不要读 LS），否则 `UiPrefs` 类型会编不过。

- [ ] **Step 4: Run tests**

Run: `bun test hub/test/uiPrefs.test.ts hub/web/test/uiPrefs.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hub/src/uiPrefs.ts hub/web/src/uiPrefs.ts hub/test/uiPrefs.test.ts hub/web/test/uiPrefs.test.ts
git commit -m "$(cat <<'EOF'
feat: persist prompt snippet list on ui-prefs

EOF
)"
```

---

### Task 2: Hub `GET/PUT /api/prompt-snippets`

**Files:**
- Modify: `hub/src/index.ts`（紧挨现有 `/api/ui-prefs` 路由）
- Test: Create `hub/test/promptSnippets-api.test.ts`（抄 `hub/test/uiPrefs-api.test.ts` 的 `createServer` 脚手架）
- Modify: `hub/test/uiPrefs-api.test.ts` — `GET missing → 200 defaults` 的 `toEqual` 现在含 `promptSnippets: []`（Task 1 已改 defaults；本任务确认该测试仍绿）

**Interfaces:**
- Consumes: `readUiPrefs`, `writeUiPrefs`, `mergeUiPrefs`, `assertPromptSnippets`, `fillSnippetIds` from Task 1
- Produces: `GET /api/prompt-snippets` → `{ snippets }`；`PUT` body `{ snippets }` → 归一化列表

- [ ] **Step 1: Failing tests** in `hub/test/promptSnippets-api.test.ts`

```ts
test("GET missing file → { snippets: [] }", async () => {
  const { base, tok } = start();
  const r = await fetch(`${base}/api/prompt-snippets`, { headers: { Authorization: `Bearer ${tok}` } });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ snippets: [] });
});

test("PUT two then GET; theme untouched", async () => {
  const { home, base, tok } = start();
  writeUiPrefs(home, { ...UI_PREFS_DEFAULTS, theme: "light" });
  const put = await fetch(`${base}/api/prompt-snippets`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json" },
    body: JSON.stringify({ snippets: [{ title: "审", body: "按清单 review" }] }),
  });
  expect(put.status).toBe(200);
  const body = await put.json() as { snippets: { id: string; title: string; body: string }[] };
  expect(body.snippets).toHaveLength(1);
  expect(body.snippets[0]!.id).toMatch(/^[a-z0-9-]{8,64}$/);
  const prefs = await (await fetch(`${base}/api/ui-prefs`, { headers: { Authorization: `Bearer ${tok}` } })).json();
  expect(prefs.theme).toBe("light");
  expect(prefs.promptSnippets).toHaveLength(1);
});

test("PUT 31 → 400 SNIPPET_LIMIT and file unchanged", async () => {
  const { home, base, tok } = start();
  writeUiPrefs(home, UI_PREFS_DEFAULTS);
  const snippets = Array.from({ length: 31 }, (_, i) => ({ title: `t${i}`, body: "b" }));
  const r = await fetch(`${base}/api/prompt-snippets`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json" },
    body: JSON.stringify({ snippets }),
  });
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ error: "SNIPPET_LIMIT" });
  const get = await fetch(`${base}/api/prompt-snippets`, { headers: { Authorization: `Bearer ${tok}` } });
  expect(await get.json()).toEqual({ snippets: [] });
});

test("PUT empty title → 400 SNIPPET_INVALID", async () => {
  const { base, tok } = start();
  const r = await fetch(`${base}/api/prompt-snippets`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json" },
    body: JSON.stringify({ snippets: [{ title: " ", body: "x" }] }),
  });
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ error: "SNIPPET_INVALID" });
});

test("GET corrupt prefs → 503 READ_FAIL", async () => {
  const { home, base, tok } = start();
  writeFileSync(join(home, "ui-prefs.json"), "{bad", { mode: 0o600 });
  const r = await fetch(`${base}/api/prompt-snippets`, { headers: { Authorization: `Bearer ${tok}` } });
  expect(r.status).toBe(503);
  expect(await r.json()).toEqual({ error: "READ_FAIL" });
});
```

- [ ] **Step 2: Run** `bun test hub/test/promptSnippets-api.test.ts`  
Expected: FAIL (404 / 路由不存在)

- [ ] **Step 3: Implement** in `hub/src/index.ts` next to ui-prefs routes:

```ts
app.get("/api/prompt-snippets", (c) => {
  const r = readUiPrefs(home);
  if (!r.ok) {
    db.query("INSERT INTO audit (ts, actor, action, target, payload) VALUES (?1,'hub','UI_PREFS_READ_FAIL',?2,?3)")
      .run(Date.now(), home, JSON.stringify({ error: r.error }));
    return c.json({ error: "READ_FAIL" }, 503);
  }
  return c.json({ snippets: r.prefs.promptSnippets });
});
app.put("/api/prompt-snippets", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "SNIPPET_INVALID" }, 400);
  }
  const asserted = assertPromptSnippets((body as { snippets?: unknown }).snippets);
  if (!asserted.ok) return c.json({ error: asserted.error }, 400);
  const cur = readUiPrefs(home);
  if (!cur.ok) {
    db.query("INSERT INTO audit (ts, actor, action, target, payload) VALUES (?1,'hub','UI_PREFS_READ_FAIL',?2,?3)")
      .run(Date.now(), home, JSON.stringify({ error: cur.error }));
    return c.json({ error: "READ_FAIL" }, 503);
  }
  try {
    const snippets = fillSnippetIds(asserted.snippets);
    const next = mergeUiPrefs(cur.prefs, { promptSnippets: snippets });
    writeUiPrefs(home, next);
    db.query("INSERT INTO audit (ts, actor, action, target, payload) VALUES (?1,'hub','PROMPT_SNIPPETS_WRITE',?2,?3)")
      .run(Date.now(), home, JSON.stringify({ count: snippets.length }));
    return c.json({ snippets: next.promptSnippets });
  } catch {
    db.query("INSERT INTO audit (ts, actor, action, target, payload) VALUES (?1,'hub','UI_PREFS_WRITE_FAIL',?2,?3)")
      .run(Date.now(), home, "{}");
    return c.json({ error: "WRITE_FAIL" }, 500);
  }
});
```

Import `assertPromptSnippets`, `fillSnippetIds` from `./uiPrefs`.

- [ ] **Step 4:** `bun test hub/test/promptSnippets-api.test.ts hub/test/uiPrefs-api.test.ts` PASS

- [ ] **Step 5: Commit** `feat: add hub prompt-snippets HTTP API`

---

### Task 3: `appendSnippetBody`

**Files:**
- Create: `hub/web/src/promptSnippets.ts`
- Test: Create `hub/web/test/promptSnippets.test.ts`

**Interfaces:**
- Produces: `export function appendSnippetBody(current: string, body: string): string`

- [ ] **Step 1: Failing test**

```ts
import { appendSnippetBody } from "../src/promptSnippets";
test("append rules", () => {
  expect(appendSnippetBody("", "foo")).toBe("foo");
  expect(appendSnippetBody("hi", "foo")).toBe("hi\nfoo");
  expect(appendSnippetBody("hi\n", "foo")).toBe("hi\nfoo");
  expect(appendSnippetBody(appendSnippetBody("hi", "foo"), "foo")).toBe("hi\nfoo\nfoo");
});
```

- [ ] **Step 2:** `bun test hub/web/test/promptSnippets.test.ts` FAIL

- [ ] **Step 3:**

```ts
export function appendSnippetBody(current: string, body: string): string {
  const b = body.trimEnd();
  if (!current) return b;
  return current.endsWith("\n") ? current + b : current + "\n" + b;
}
```

- [ ] **Step 4:** test PASS

- [ ] **Step 5: Commit** `feat: append prompt snippets to composer draft`

---

### Task 4: 中转路由 + hub cmd（Client 与 Attach）

**Files:**
- Modify: `relay/src/server.ts` — `waitHub` 类型加 `snippets?: { id: string; title: string; body: string }[]`；`cmd.result` resolve 传 `snippets: msg.snippets`；`hubCmdStatus` 加 `SNIPPET_INVALID`/`SNIPPET_LIMIT` → 400，`READ_FAIL` → 503，`WRITE_FAIL` → 500
- Modify: `hub/src/relayClient.ts` `onCommand`
- Modify: `hub/src/relayAttach.ts` `onCommand`（**同样两段，禁止只改一份**）
- Test: `relay/test/server.test.ts`

**Interfaces:**
- Produces:
  - `GET /mobile/prompt-snippets` → 200 `{ snippets }` 或 503 `HUB_OFFLINE`
  - `PUT /mobile/prompt-snippets` 走 `checkRate`；GET **不**走 `checkRate`
  - cmd: `cmd.promptSnippetsGet` / `cmd.promptSnippetsPut`

- [ ] **Step 1: Failing relay tests**（用现有 `start` / `connectHub`；无 hub 时 GET/PUT 均 503）

```ts
test("prompt-snippets hub offline → 503", async () => {
  const s = start();
  const fleet = s.createFleet();
  const headers = { Authorization: `Bearer ${fleet.operatorToken}` };
  expect((await fetch(url(s, "/mobile/prompt-snippets"), { headers })).status).toBe(503);
  const put = await fetch(url(s, "/mobile/prompt-snippets"), {
    method: "PUT", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ snippets: [] }),
  });
  expect(put.status).toBe(503);
  expect(await put.json()).toEqual({ error: "HUB_OFFLINE" });
});

test("prompt-snippets get/put round-trip via fake hub", async () => {
  const s = start();
  const fleet = s.createFleet();
  const ws = await connectHub(s, fleet.fleet, fleet.hubSecret);
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.type === "cmd.promptSnippetsGet") {
      ws.send(JSON.stringify({ type: "cmd.result", requestId: msg.requestId, ok: true, snippets: [{ id: "ok-id-01", title: "t", body: "b" }] }));
    }
    if (msg.type === "cmd.promptSnippetsPut") {
      ws.send(JSON.stringify({ type: "cmd.result", requestId: msg.requestId, ok: true, snippets: msg.snippets }));
    }
  });
  await new Promise((r) => setTimeout(r, 50));
  const headers = { Authorization: `Bearer ${fleet.operatorToken}`, "content-type": "application/json" };
  const g = await fetch(url(s, "/mobile/prompt-snippets"), { headers });
  expect(g.status).toBe(200);
  expect(await g.json()).toEqual({ snippets: [{ id: "ok-id-01", title: "t", body: "b" }] });
  const p = await fetch(url(s, "/mobile/prompt-snippets"), {
    method: "PUT", headers, body: JSON.stringify({ snippets: [{ id: "ok-id-02", title: "x", body: "y" }] }),
  });
  expect(p.status).toBe(200);
  const pj = await p.json() as { snippets: unknown[]; run?: unknown };
  expect(pj.snippets[0]).toMatchObject({ id: "ok-id-02" });
  expect(pj.run).toBeUndefined();
  ws.close();
});
```

- [ ] **Step 2:** `bun test relay/test/server.test.ts` FAIL on new tests

- [ ] **Step 3: Implement routes** after `/mobile/workspaces`（GET 检查 `hub_online` + `sendHub`，与 followup 相同；GET 不要 `checkRate`）：

Hub 侧 `onCommand` 两份文件都加：

```ts
if (msg.type === "cmd.promptSnippetsGet") {
  const r = await hubFetch("/api/prompt-snippets");
  const body = await r.json().catch(() => ({})) as any;
  if (!r.ok) return fail(body.error ?? "HUB_ERROR");
  send({ type: "cmd.result", requestId, ok: true, snippets: body.snippets ?? [] });
  return;
}
if (msg.type === "cmd.promptSnippetsPut") {
  const r = await hubFetch("/api/prompt-snippets", {
    method: "PUT",
    body: JSON.stringify({ snippets: msg.snippets ?? [] }),
  });
  const body = await r.json().catch(() => ({})) as any;
  if (!r.ok) return fail(body.error ?? "HUB_ERROR");
  send({ type: "cmd.result", requestId, ok: true, snippets: body.snippets ?? [] });
  return;
}
```

`cmd.result` 处理：

```ts
p.resolve({ ok: !!msg.ok, error: msg.error, run: msg.run, snippets: msg.snippets });
```

成功响应 `c.json({ snippets: result.snippets ?? [] })`，**不要**包 `run`。

- [ ] **Step 4:** `bun test relay/test hub/test/relayClient.test.ts hub/test/relayAttach.test.ts` PASS（回归）

- [ ] **Step 5: Commit** `feat: relay prompt-snippets to hub prefs`

---

### Task 5: 中台条 + 设置 + App 级 state

**Files:**
- Create: `hub/web/src/components/PromptSnippetBar.tsx`
- Modify: `hub/web/src/api.ts` — `getPromptSnippets` / `putPromptSnippets`
- Modify: `hub/web/src/App.tsx` — 提升 `snippets` state；打开设置/派发时 GET；`put` 失败回滚
- Modify: `hub/web/src/components/Modals.tsx` `DispatchModal`
- Modify: `hub/web/src/components/RunDetail.tsx`
- Modify: `hub/web/src/components/SettingsModal.tsx`
- Test: `hub/web/test/dispatchModal.test.tsx`、`hub/web/test/settingsModal.test.tsx`；可选 `hub/web/test/promptSnippetBar.test.tsx`

**Interfaces:**
- Consumes: `appendSnippetBody`（Task 3）；`PromptSnippet` 类型（web `uiPrefs.ts`）
- Produces: 两处输入框上方条；设置「快捷提示词」行内保存/删除

`api.ts`：

```ts
getPromptSnippets: () => req("/api/prompt-snippets").then(async (r) => {
  if (r.status === 503) throw new Error("READ_FAIL");
  if (!r.ok) throw new Error(`prompt-snippets ${r.status}`);
  return r.json() as Promise<{ snippets: PromptSnippet[] }>;
}),
putPromptSnippets: (snippets: PromptSnippet[]) =>
  req("/api/prompt-snippets", { method: "PUT", body: JSON.stringify({ snippets }) }).then(async (r) => {
    const j = await r.json().catch(() => ({})) as { error?: string; snippets?: PromptSnippet[] };
    if (!r.ok) throw new Error(j.error ?? `prompt-snippets put ${r.status}`);
    return j as { snippets: PromptSnippet[] };
  }),
```

`PromptSnippetBar`：横排 `button` 显示 `title`（`onClick` → `onAppend(s.body)`）；`+` 打开小表单「标题」「提示词」「保存/取消」。`snippets.length >= 30` 时 `+` `disabled` 且 `title="最多 30 条"`。胶囊上禁止删除叉。

`App.tsx`：

```ts
const [snippets, setSnippets] = useState<PromptSnippet[]>([]);
const reloadSnippets = () => {
  void api.getPromptSnippets()
    .then((r) => setSnippets(Array.isArray(r.snippets) ? r.snippets : []))
    .catch(() => setSnippets([]));
};
useEffect(() => { if (authed) reloadSnippets(); }, [authed]);

async function saveSnippets(next: PromptSnippet[]) {
  const prev = snippets;
  setSnippets(next);
  try {
    const r = await api.putPromptSnippets(next);
    setSnippets(r.snippets);
  } catch (e) {
    setSnippets(prev);
    throw e;
  }
}
```

把 `snippets` / `saveSnippets` / `reloadSnippets` 传给 `DispatchModal`、`RunDetail`、`SettingsModal`。打开这些 UI 时可再 `reloadSnippets()`。

`DispatchModal` / `RunDetail`：textarea **上方**挂 `<PromptSnippetBar onAppend={(body) => setPrompt(appendSnippetBody(prompt, body))} onAdd={async (title, body) => { await saveSnippets([...snippets, { id: crypto.randomUUID(), title, body }]); }} />`  
（PUT 可带客户端合法 uuid；hub 会保留。也允许不带 id，但 web 用 uuid 以便乐观列表稳定。）

设置区：标题「快捷提示词」；空列表文案「还没有快捷提示词，在输入框上方点 + 添加」；每行标题 input、提示词 textarea、按钮「保存」「删除」。保存：替换该项后 `saveSnippets`。删除：filter 后 `saveSnippets`。失败用 `SNIPPET_*` 中文（规格 §4.6）。

测试：

- `dispatchModal.test.tsx`：markup 含 `+` 或「快捷」/可访问名 `添加快捷提示词`（组件用 `aria-label="添加快捷提示词"`）。
- `settingsModal.test.tsx`：含「快捷提示词」；仍含「黑夜」「超大」；**删掉**「only」那种禁止第三项的断言，改为仍不含「解绑」「跟随系统」。

- [ ] **Step 1:** 扩展上述测试令其失败  
- [ ] **Step 2:** `bun test hub/web/test/dispatchModal.test.tsx hub/web/test/settingsModal.test.tsx` FAIL  
- [ ] **Step 3:** 实现组件与接线  
- [ ] **Step 4:** `bun test hub/web/test` PASS  
- [ ] **Step 5: Commit** `feat: hub web prompt snippet bar and settings`

---

### Task 6: iOS API + 派发/续聊 + 设置

**Files:**
- Modify: `mobile/ios/ArmadaRemote/RelayAPI.swift`
- Modify: `mobile/ios/ArmadaRemote/ArmadaRemoteApp.swift` `Session`（内存 `[PromptSnippet]`；`unbind` 清空；禁止 UserDefaults key）
- Modify: `mobile/ios/ArmadaRemote/Screens.swift` `DispatchSheet` + `SettingsView`

**Interfaces:**
- Consumes: `/mobile/prompt-snippets` JSON `{ snippets: [{ id, title, body }] }`
- Produces: 与规格 §4.6 相同中文

```swift
struct PromptSnippet: Codable, Equatable, Identifiable {
    var id: String
    var title: String
    var body: String
}

func promptSnippets() async throws -> [PromptSnippet]
func putPromptSnippets(_ snippets: [PromptSnippet]) async throws -> [PromptSnippet]
```

`operatorMessage` 增加：

| code | 文案 |
| --- | --- |
| SNIPPET_INVALID | 标题和提示词都不能为空，且不要超长 |
| SNIPPET_LIMIT | 最多 30 条快捷提示词 |
| READ_FAIL | 读取快捷提示词失败 |
| WRITE_FAIL | 保存失败，请重试 |

`DispatchSheet`：`TextEditor` 上方横排标题按钮 + `+`。插入：

```swift
func appendSnippetBody(_ current: String, _ body: String) -> String {
    let b = body.trimmingCharacters(in: .newlines) // 对齐 trimEnd：去掉末尾换行即可，不要 trimStart
    // Swift 无 trimEnd；用: 去掉 trailing newlines/spaces 与 JS trimEnd 接近：
    let trimmedEnd = body.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
    if current.isEmpty { return trimmedEnd }
    return current.hasSuffix("\n") ? current + trimmedEnd : current + "\n" + trimmedEnd
}
```

用与 JS 相同：`trimEnd` = 去掉末尾空白。Swift：`body.trimmingCharacters(in: .whitespacesAndNewlines)` 会 trim 两端——**不要用**。实现：

```swift
func appendSnippetBody(_ current: String, _ body: String) -> String {
    let b = body.replacingOccurrences(of: #"[\t\n\r ]+$"#, with: "", options: .regularExpression)
    if current.isEmpty { return b }
    return current.hasSuffix("\n") ? current + b : current + "\n" + b
}
```

`SettingsView`：`@EnvironmentObject var session: Session`；Section「快捷提示词」；行内改 + 保存/删除。确认 `WorkspaceListView` 已 `.environmentObject(session)` 能传到设置。打开设置/`DispatchSheet` 时 `Task { await session.loadSnippets() }`。GET 失败 → 空数组 + `lastError` 文案。PUT 失败回滚内存。

无 iOS 单测 harness 则不强造 XCTest；错误码字符串必须与 Android 任务同一表（本任务先写下 iOS switch，Task 7 复制）。

- [ ] **Step 1–4:** 实现并对一下 `grep -n "ui-prefs" mobile/ios` 必须无命中  
- [ ] **Step 5: Commit** `feat: iOS prompt snippets on dispatch and settings`

---

### Task 7: Android API + 派发/续聊 + 设置

**Files:**
- Modify: `mobile/android/core/src/main/kotlin/app/armada/remote/OperatorMessages.kt`
- Test: `mobile/android/core/src/test/kotlin/app/armada/remote/OperatorMessagesTest.kt`
- Modify: `mobile/android/app/src/main/java/app/armada/remote/RelayClient.kt`
- Modify: `mobile/android/app/src/main/java/app/armada/remote/SessionVm.kt`
- Modify: `mobile/android/app/src/main/java/app/armada/remote/MainActivity.kt` `DispatchSheet` + `SettingsScreen`

**Interfaces:** 与 Task 6 同一 JSON、同一中文、同一 `appendSnippetBody` 规则（Kotlin `trimEnd()`）。

- [ ] **Step 1: Failing test** in `OperatorMessagesTest.kt`

```kotlin
@Test
fun snippetErrorsMatchIos() {
    assertEquals("标题和提示词都不能为空，且不要超长", operatorMessage("SNIPPET_INVALID"))
    assertEquals("最多 30 条快捷提示词", operatorMessage("SNIPPET_LIMIT"))
    assertEquals("读取快捷提示词失败", operatorMessage("READ_FAIL"))
    assertEquals("保存失败，请重试", operatorMessage("WRITE_FAIL"))
    assertEquals("推送登记失败", operatorMessage("INVALID"))
}
```

（最后一行锁定不得改坏现网 `INVALID`。）

- [ ] **Step 2:** `cd mobile/android && ./gradlew :core:test` FAIL（不需要 Android SDK）  
- [ ] **Step 3:** `when` 分支 + RelayClient get/put + SessionVm 内存列表（unbind 随 `UiState()` 清空，不写 SharedPreferences）+ UI  
- [ ] **Step 4:** core 测试 PASS；`grep -R "ui-prefs" mobile/android` 无命中  
- [ ] **Step 5: Commit** `feat: Android prompt snippets on dispatch and settings`

---

## Verify（全部任务后，controller）

```bash
bun test hub/test extension/test hooks/test hub/web/test desktop-core/test relay/test
```

然后 `git push origin master`。A9 打包 overlay 由人在停 7380 后点一次。
