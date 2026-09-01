import { invoke } from "@tauri-apps/api/core";
import { formatJoinUri, parseJoinUri } from "../../desktop-core/src/index.ts";

const errEl = () => document.querySelector<HTMLPreElement>("#err");
const uriEl = () => document.querySelector<HTMLInputElement>("#join-uri");

type CreateFleetResult = {
  decision: "reuse-owned" | "spawn" | "attach";
  token: string;
  shareCandidates: { ipv4: string; name: string; maybeUnreachable: boolean }[];
  ownedHubPid: number | null;
};

type JoinFleetResult = {
  webviewOrigin: string;
  token: string;
  cursorHubUrl: string;
  joinSelf: boolean;
};

function setErr(msg: string) {
  const el = errEl();
  if (el) el.textContent = msg;
}

function parsePasted(raw: string) {
  const r = parseJoinUri(raw);
  if ("error" in r) {
    setErr(r.error === "incomplete" ? "链接不完整" : "链接无效");
    return false;
  }
  return true;
}

window.addEventListener("DOMContentLoaded", () => {
  const input = uriEl();
  if (input) input.placeholder = formatJoinUri("192.168.1.23:7380", "<token>");

  document.querySelector("#create")?.addEventListener("click", () => {
    void invoke<CreateFleetResult>("create_fleet")
      .then((r) => {
        const lines = [
          `决策 ${r.decision} pid=${r.ownedHubPid ?? "none"}`,
          ...r.shareCandidates.map((c) => {
            const flag = c.maybeUnreachable ? " (maybe unreachable)" : "";
            return `${c.name} ${c.ipv4}${flag}\n${formatJoinUri(`${c.ipv4}:7380`, r.token)}`;
          }),
        ];
        if (r.shareCandidates.length === 0) lines.push("无局域网分享地址");
        setErr(lines.join("\n\n"));
      })
      .catch((e) => setErr(String(e)));
  });
  document.querySelector("#join")?.addEventListener("click", () => {
    const raw = uriEl()?.value ?? "";
    if (!parsePasted(raw)) return;
    void invoke<JoinFleetResult>("join_fleet", { uri: raw })
      .then((r) => {
        setErr(`已接入 ${r.webviewOrigin}\ncursorHubUrl=${r.cursorHubUrl}\njoinSelf=${r.joinSelf}`);
      })
      .catch((e) => setErr(String(e)));
  });
  document.querySelector("#join-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = uriEl()?.value ?? "";
    if (!parsePasted(raw)) return;
    void invoke<JoinFleetResult>("join_fleet", { uri: raw })
      .then((r) => {
        setErr(`已接入 ${r.webviewOrigin}\ncursorHubUrl=${r.cursorHubUrl}\njoinSelf=${r.joinSelf}`);
      })
      .catch((err) => setErr(String(err)));
  });
});
