# Offline Workspace Slots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop advertising last-known workspaces after a machine has no live connections or is `offline`, so the board sidebar no longer shows gray stale slots; keep opening a card from a notification even when that slot is gone.

**Architecture:** Single write-path invariant in `Registry`: `open_workspaces` is the live WS union, or `[]`. Board selection moves to `resolveSelectedWorkspace` so a vanished slot snaps away unless a selected run still belongs to it (ghost). No second UI filter on `status==="online"`.

**Tech Stack:** bun:test, SQLite via `openDb`, existing hub WS mocks, React board in `hub/web`.

**Spec:** `docs/superpowers/specs/2026-09-10-armada-offline-workspace-slots-design.md`

## Global Constraints

- `machines.open_workspaces` = live connection union; empty union or `status='offline'` ⇒ `[]` persisted.
- Do not add `listWorkspaceSlots` filter on `status === "online"`.
- Do not delete `machines` rows; do not change top-bar `在线 x/y`; do not change run state machine / ingest / extension / desktop shell.
- `onMachinesChanged` must fire when advertised workspaces become `[]` (including `markOffline` / sweep with no live runs).
- Constructor normalizes existing `offline` rows with leftover workspaces; no SSE from constructor.
- Ghost selection only when `encodeWorkspaceKey(selectedRun.machine_id, selectedRun.workspace_root) === selectedWs`.
- Work on a branch from `origin/master`. Do not commit on `feat/lan-fleet-discovery`.
- TDD: failing test first. `cd` to the Armada repo root for all `bun test` commands.

---

### Task 1: Registry advertised workspaces = live union

**Files:**
- Modify: `hub/src/registry.ts` (`constructor`, `markOffline`, `refreshMachineWorkspaces`)
- Modify: `hub/test/registry.test.ts`
- Modify: `hub/test/ws.test.ts` (sweep assertion A5)

**Interfaces:**
- Consumes: existing `Registry.onRegister` / `onClose` / `onHeartbeat` / `sweep`; `ArmadaSocket` `{ data, send, close }`
- Produces: same public methods; `markOffline` now also writes `open_workspaces='[]'` and calls `onMachinesChanged` when status or workspaces actually change; empty union persists `[]`

- [ ] **Step 1: Write the failing tests**

Append to `hub/test/registry.test.ts` (keep existing `setup` / `machine` helpers). Add a tiny socket factory next to `setup`:

```ts
import type { ArmadaSocket } from "../src/ws";

function fakeWs(): ArmadaSocket {
  return { data: { registered: false }, send() {}, close() {} };
}

function register(reg: Registry, ws: ArmadaSocket, extra: Record<string, unknown> = {}) {
  reg.onRegister(ws, {
    machineId: "m-1", windowId: "w-1", name: "Mac-A", os: "darwin-arm64",
    openWorkspaces: ["/ws/a"],
    ...extra,
  });
}
```

Add these tests (do not weaken existing ones):

```ts
  test("last window close persists empty open_workspaces and notifies", () => {
    const { reg } = setup();
    const ws = fakeWs();
    let n = 0;
    register(reg, ws);
    reg.onMachinesChanged = () => { n += 1; };
    reg.onClose(ws);
    expect(JSON.parse(reg.getMachine("m-1")!.open_workspaces)).toEqual([]);
    expect(reg.getMachine("m-1")!.status).toBe("online");
    expect(n).toBe(1);
  });

  test("closing one of two windows keeps the other workspace", () => {
    const { reg } = setup();
    const a = fakeWs();
    const b = fakeWs();
    register(reg, a, { windowId: "w-1", openWorkspaces: ["/ws/a"] });
    register(reg, b, { windowId: "w-2", openWorkspaces: ["/ws/b"] });
    expect(JSON.parse(reg.getMachine("m-1")!.open_workspaces).sort()).toEqual(["/ws/a", "/ws/b"]);
    reg.onClose(a);
    expect(JSON.parse(reg.getMachine("m-1")!.open_workspaces)).toEqual(["/ws/b"]);
  });

  test("markOffline clears workspaces and notifies", () => {
    const { reg } = setup();
    reg.upsertMachine(machine);
    let n = 0;
    reg.onMachinesChanged = () => { n += 1; };
    reg.markOffline("m-1");
    expect(reg.getMachine("m-1")!.status).toBe("offline");
    expect(JSON.parse(reg.getMachine("m-1")!.open_workspaces)).toEqual([]);
    expect(n).toBe(1);
  });

  test("constructor clears leftover workspaces on already-offline rows", () => {
    const { db } = setup();
    db.query(`
      INSERT INTO machines (id, name, os, open_workspaces, status)
      VALUES ('m-old', 'Old', 'darwin', ?1, 'offline')
    `).run(JSON.stringify(["/old"]));
    const reg = new Registry(db);
    expect(JSON.parse(reg.getMachine("m-old")!.open_workspaces)).toEqual([]);
    expect(reg.getMachine("m-old")!.status).toBe("offline");
  });
```

In `hub/test/ws.test.ts`, extend `"sweep marks stale machine offline"`:

```ts
    expect(h.registry.getMachine("m-1")!.status).toBe("offline");
    expect(JSON.parse(h.registry.getMachine("m-1")!.open_workspaces)).toEqual([]);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test hub/test/registry.test.ts hub/test/ws.test.ts`

Expected: FAIL because last close still leaves `["/ws/a"]` (the `union.size === 0` early return), `markOffline` leaves workspaces, constructor does not UPDATE offline rows, sweep assertion on `[]` fails.

- [ ] **Step 3: Minimal production change**

In `hub/src/registry.ts`:

1. Constructor — after `constructor(private db: Database) {}` add a body that runs:

```ts
constructor(private db: Database) {
  this.db.query(
    "UPDATE machines SET open_workspaces='[]' WHERE status='offline' AND open_workspaces != '[]'",
  ).run();
}
```

2. Replace `markOffline`:

```ts
markOffline(id: string): void {
  const row = this.getMachine(id);
  if (!row) return;
  const already = row.status === "offline" && row.open_workspaces === "[]";
  this.db.query("UPDATE machines SET status='offline', open_workspaces='[]' WHERE id=?1").run(id);
  if (!already) this.onMachinesChanged();
}
```

Note: existing `markOffline` did not no-op missing ids; `getMachine` null → return is OK (UPDATE of missing id was a no-op anyway).

3. In `refreshMachineWorkspaces`, replace the `if (union.size === 0) return false;` block with persist-empty:

```ts
private refreshMachineWorkspaces(machineId: string): boolean {
  const union = new Set<string>();
  for (const c of this.conns.values()) {
    if (c.machineId !== machineId) continue;
    for (const w of c.openWorkspaces) union.add(w);
  }
  const next = [...union];
  const prev = this.storedWorkspaces(machineId);
  if (!workspaceListChanged(prev, next)) return false;
  this.db.query("UPDATE machines SET open_workspaces=?1 WHERE id=?2")
    .run(JSON.stringify(next), machineId);
  return true;
}
```

Do not add a UI filter. Do not debounce.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test hub/test/registry.test.ts hub/test/ws.test.ts`

Expected: PASS. If `"markOffline flips status"` still passes, leave it (status check still valid).

- [ ] **Step 5: Commit**

```bash
git add hub/src/registry.ts hub/test/registry.test.ts hub/test/ws.test.ts docs/superpowers/specs/2026-09-10-armada-offline-workspace-slots-design.md docs/superpowers/plans/2026-09-10-armada-offline-workspace-slots.md
git commit -m "$(cat <<'EOF'
fix: drop advertised workspaces when a machine goes idle

Sidebar was listing last-known folders after every Cursor window closed.
Persist the live union (empty if none) and clear rows already marked offline.
EOF
)"
```

---

### Task 2: Ghost-aware workspace selection

**Files:**
- Modify: `hub/web/src/boardState.ts` (add `resolveSelectedWorkspace`)
- Modify: `hub/web/src/App.tsx` (use it; pass selected run row from live or hidden lists)
- Modify: `hub/web/test/boardState.test.ts`
- Do **not** modify `alertOpen.ts` (it already sets the key; resolver must honor it)

**Interfaces:**
- Consumes: `WorkspaceSlot`, `encodeWorkspaceKey`, `listWorkspaceSlots`
- Produces:

```ts
export function resolveSelectedWorkspace(
  slots: WorkspaceSlot[],
  selectedWs: string | null,
  selectedRun: { machine_id: string; workspace_root: string } | null,
): string | null
```

- [ ] **Step 1: Write the failing tests**

In `hub/web/test/boardState.test.ts`, import `resolveSelectedWorkspace`. Add:

```ts
describe("resolveSelectedWorkspace", () => {
  const onlineA = {
    machineId: "m-1", machineName: "A", os: "darwin", root: "/ws/a", online: true,
  };
  const onlineB = {
    machineId: "m-2", machineName: "B", os: "darwin", root: "/ws/b", online: true,
  };
  const keyA = encodeWorkspaceKey("m-1", "/ws/a");
  const keyB = encodeWorkspaceKey("m-2", "/ws/b");

  test("keeps selected when the slot is still listed", () => {
    expect(resolveSelectedWorkspace([onlineA, onlineB], keyA, null)).toBe(keyA);
  });

  test("snaps to first online slot when selected vanished and no run is open", () => {
    expect(resolveSelectedWorkspace([onlineB], keyA, null)).toBe(keyB);
  });

  test("keeps vanished workspace when the open card belongs to it", () => {
    expect(resolveSelectedWorkspace(
      [onlineB],
      keyA,
      { machine_id: "m-1", workspace_root: "/ws/a" },
    )).toBe(keyA);
  });

  test("does not ghost when the open card is a different workspace", () => {
    expect(resolveSelectedWorkspace(
      [onlineB],
      keyA,
      { machine_id: "m-2", workspace_root: "/ws/b" },
    )).toBe(keyB);
  });

  test("returns null when nothing is listed and there is no ghost", () => {
    expect(resolveSelectedWorkspace([], keyA, null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/web/test/boardState.test.ts`

Expected: FAIL — `resolveSelectedWorkspace` is not exported.

- [ ] **Step 3: Implement function + wire App**

Add to `hub/web/src/boardState.ts` immediately after `groupSlotsByMachine`:

```ts
export function resolveSelectedWorkspace(
  slots: WorkspaceSlot[],
  selectedWs: string | null,
  selectedRun: { machine_id: string; workspace_root: string } | null,
): string | null {
  if (selectedWs && slots.some((s) => encodeWorkspaceKey(s.machineId, s.root) === selectedWs)) {
    return selectedWs;
  }
  if (
    selectedWs &&
    selectedRun &&
    encodeWorkspaceKey(selectedRun.machine_id, selectedRun.workspace_root) === selectedWs
  ) {
    return selectedWs;
  }
  const first = slots.find((s) => s.online) ?? slots[0];
  return first ? encodeWorkspaceKey(first.machineId, first.root) : null;
}
```

In `hub/web/src/App.tsx`:

- Add `resolveSelectedWorkspace` to the `boardState` import.
- Replace the `resolvedWs` memo with:

```ts
  const selectedRunRow = useMemo(() => {
    if (!selectedRun) return null;
    return runs.find((r) => r.id === selectedRun) ?? hiddenRuns.find((r) => r.id === selectedRun) ?? null;
  }, [selectedRun, runs, hiddenRuns]);
  const resolvedWs = useMemo(
    () => resolveSelectedWorkspace(slots, selectedWs, selectedRunRow),
    [slots, selectedWs, selectedRunRow],
  );
```

Do not call `selectWorkspace` from `openRunFromAlert` (it already must not). W3 is satisfied if `openRunFromAlert` sets `selectedWs` + `selectedRun` and the resolver ghosts.

W4 needs no Sidebar change: empty `slots` already renders `暂无在线工作区`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test hub/web/test/boardState.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/web/src/boardState.ts hub/web/src/App.tsx hub/web/test/boardState.test.ts
git commit -m "$(cat <<'EOF'
fix: keep alert cards when an offline workspace leaves the sidebar

Snap the board to a live slot after a workspace disappears, but do not
steal the selection while that run's detail is open.
EOF
)"
```

---

### Task 3: Suite gate

- [ ] **Step 1: Run hub + web tests**

Run: `bun test hub/test hub/web/test`

Expected: PASS (0 fail). If a pre-existing failure is on `origin/master` and unrelated, stop and report; do not “fix” ingest/stop in this branch.

- [ ] **Step 2: Spec status line**

In the spec header, change `**未实施**` to `v1 已按计划落地；验收见 A1–A5 / W1–W4 单测`. Do not claim packaged Armada.app overlay was done.

- [ ] **Step 3: Commit spec status if it changed**

```bash
git add docs/superpowers/specs/2026-09-10-armada-offline-workspace-slots-design.md
git commit -m "$(cat <<'EOF'
docs: mark offline workspace-slot spec implemented
EOF
)"
```

---

## Spec coverage

| Spec | Task |
| --- | --- |
| A1 last close → `[]` + notify | Task 1 |
| A2 two windows, close one | Task 1 |
| A3 markOffline | Task 1 |
| A4 constructor normalize | Task 1 |
| A5 sweep | Task 1 `ws.test.ts` |
| W1 snap away | Task 2 |
| W2 / W3 ghost | Task 2 |
| W4 empty copy | already Sidebar; no code |
| No UI double-filter | Global constraint |
| Mac/Windows same hub path | Task 1 (OS-agnostic) |
