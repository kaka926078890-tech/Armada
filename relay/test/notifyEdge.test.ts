import { describe, expect, test } from "bun:test";
import { notifyEdges, NEED_INPUT_TITLE, ALERT_TITLE } from "../src/notifyEdge";

const snap = {
  runId: "r-1",
  prompt: "fix the bug",
  status: "running",
  pendingAsk: null as unknown,
};

const emptyPrev = { notifiedStatus: null as string | null, notifiedAskId: null as string | null };

describe("notifyEdges terminal", () => {
  test("does not fire on seed snapshot already completed", () => {
    const prev = { notifiedStatus: "completed", notifiedAskId: null };
    expect(notifyEdges(prev, { ...snap, status: "completed" })).toEqual({
      edges: [],
      notifiedStatus: "completed",
      notifiedAskId: null,
    });
  });

  test("fires once when running becomes completed", () => {
    const first = notifyEdges(emptyPrev, { ...snap, status: "completed" });
    expect(first.edges.map((e) => e.kind)).toEqual(["completed"]);
    expect(first.edges[0].title).toBe(ALERT_TITLE.completed);
    expect(first.edges[0].body).toBe("fix the bug");
    const again = notifyEdges(
      { notifiedStatus: first.notifiedStatus, notifiedAskId: first.notifiedAskId },
      { ...snap, status: "completed" },
    );
    expect(again.edges).toEqual([]);
  });

  test("followup complete after another running cycle fires again", () => {
    const afterDone = notifyEdges(
      { notifiedStatus: "completed", notifiedAskId: null },
      { ...snap, status: "running" },
    );
    expect(afterDone.edges).toEqual([]);
    expect(afterDone.notifiedStatus).toBeNull();
    const again = notifyEdges(
      { notifiedStatus: afterDone.notifiedStatus, notifiedAskId: afterDone.notifiedAskId },
      { ...snap, status: "completed" },
    );
    expect(again.edges.map((e) => e.kind)).toEqual(["completed"]);
  });

  test("new id that appears already completed fires", () => {
    const first = notifyEdges(emptyPrev, { ...snap, runId: "r-2", status: "completed" });
    expect(first.edges.map((e) => e.kind)).toEqual(["completed"]);
  });

  test("running -> error/unknown/aborted fires; cancelled does not", () => {
    expect(notifyEdges(emptyPrev, { ...snap, status: "error" }).edges[0].kind).toBe("error");
    expect(notifyEdges(emptyPrev, { ...snap, status: "unknown" }).edges[0].kind).toBe("unknown");
    expect(notifyEdges(emptyPrev, { ...snap, status: "aborted" }).edges[0].kind).toBe("aborted");
    expect(notifyEdges(emptyPrev, { ...snap, status: "cancelled" }).edges).toEqual([]);
  });
});

describe("notifyEdges ask", () => {
  const pending = {
    request_id: "ask-1",
    questions: [{ id: "q0", prompt: "这是本机验证用的 Questions 框", options: [] }],
  };

  test("fires once when pending_ask appears; clearing does not fire completed", () => {
    const first = notifyEdges(emptyPrev, { ...snap, pendingAsk: pending });
    expect(first.edges.map((e) => e.kind)).toEqual(["ask"]);
    expect(first.edges[0].title).toBe(NEED_INPUT_TITLE);
    expect(first.edges[0].body).toContain("Questions 框");
    const same = notifyEdges(
      { notifiedStatus: first.notifiedStatus, notifiedAskId: first.notifiedAskId },
      { ...snap, pendingAsk: pending },
    );
    expect(same.edges).toEqual([]);
    const cleared = notifyEdges(
      { notifiedStatus: same.notifiedStatus, notifiedAskId: same.notifiedAskId },
      snap,
    );
    expect(cleared.edges).toEqual([]);
    expect(cleared.notifiedAskId).toBeNull();
  });

  test("new request_id fires ask again", () => {
    const prev = { notifiedStatus: null, notifiedAskId: "ask-1" };
    const next = notifyEdges(prev, {
      ...snap,
      pendingAsk: { ...pending, request_id: "ask-2" },
    });
    expect(next.edges.map((e) => e.kind)).toEqual(["ask"]);
    expect(next.notifiedAskId).toBe("ask-2");
  });

  test("plan/build pendingAsk is treated as ask", () => {
    const first = notifyEdges(emptyPrev, {
      ...snap,
      pendingAsk: { request_id: "plan-1", kind: "plan", questions: [{ prompt: "Created Plan" }] },
    });
    expect(first.edges.map((e) => e.kind)).toEqual(["ask"]);
  });
});
