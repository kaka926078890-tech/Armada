import { formatJoinUri, parseJoinUri } from "../../desktop-core/src/index.ts";

const errEl = () => document.querySelector<HTMLPreElement>("#err");
const uriEl = () => document.querySelector<HTMLInputElement>("#join-uri");

function setErr(msg: string) {
  const el = errEl();
  if (el) el.textContent = msg;
}

function parsePasted(raw: string) {
  const r = parseJoinUri(raw);
  if ("error" in r) {
    setErr(r.error === "incomplete" ? "链接不完整" : "链接无效");
    return;
  }
  setErr(`已解析 ${r.hubHostPort}`);
}

window.addEventListener("DOMContentLoaded", () => {
  const input = uriEl();
  if (input) input.placeholder = formatJoinUri("192.168.1.23:7380", "<token>");

  document.querySelector("#create")?.addEventListener("click", () => {
    setErr("创建舰队尚未接入（后续任务）");
  });
  document.querySelector("#join")?.addEventListener("click", () => {
    parsePasted(uriEl()?.value ?? "");
  });
  document.querySelector("#join-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    parsePasted(uriEl()?.value ?? "");
  });
});
