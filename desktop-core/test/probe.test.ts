import { describe, expect, test } from "bun:test";
import { probeHub } from "../src/probe";

function mockFetch(seq: Array<{ urlIncludes: string; status: number; body: unknown }>): typeof fetch {
  let i = 0;
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const step = seq[i++];
    if (!step || !url.includes(step.urlIncludes)) throw new Error(`unexpected ${url}`);
    return new Response(JSON.stringify(step.body), { status: step.status });
  }) as typeof fetch;
}

test("health 200 machines 401 is not authorized", async () => {
  const r = await probeHub("http://127.0.0.1:7380", "tok", mockFetch([
    { urlIncludes: "/api/health", status: 200, body: { ok: true, name: "armada-hub" } },
    { urlIncludes: "/api/machines", status: 401, body: { error: "unauthorized" } },
  ]));
  expect(r).toEqual({ connectivity: "ok", auth: "unauthorized", healthName: "armada-hub" });
});

test("health fail does not call machines", async () => {
  const r = await probeHub("http://192.168.1.9:7380", "tok", mockFetch([
    { urlIncludes: "/api/health", status: 500, body: {} },
  ]));
  expect(r.connectivity).toBe("fail");
  expect(r.auth).toBe("skipped");
});

test("both 200", async () => {
  const r = await probeHub("http://127.0.0.1:7380", "tok", mockFetch([
    { urlIncludes: "/api/health", status: 200, body: { ok: true, name: "armada-hub" } },
    { urlIncludes: "/api/machines", status: 200, body: [] },
  ]));
  expect(r).toMatchObject({ connectivity: "ok", auth: "ok" });
});
