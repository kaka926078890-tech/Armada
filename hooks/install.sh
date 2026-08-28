#!/bin/sh
# Armada hooks 安装器: read-modify-write 合并 ~/.cursor/hooks.json,不动既有条目。
# 注意:本脚本跑在操作员/被控机 shell 里(非 hook 热路径),允许使用系统 python3 做 JSON 合并。
set -e
HOOKS_DIR="$HOME/.cursor/hooks"
HOOKS_JSON="$HOME/.cursor/hooks.json"
SCRIPT_SRC="$(cd "$(dirname "$0")" && pwd)/armada-spool.sh"
TEMPLATE="$(cd "$(dirname "$0")" && pwd)/hooks.template.json"
mkdir -p "$HOOKS_DIR"
cp "$SCRIPT_SRC" "$HOOKS_DIR/armada-spool.sh"
chmod +x "$HOOKS_DIR/armada-spool.sh"
[ -f "$HOOKS_JSON" ] && cp "$HOOKS_JSON" "$HOOKS_JSON.bak.$(date +%s)"
SCRIPT="$HOOKS_DIR/armada-spool.sh" TEMPLATE="$TEMPLATE" HOOKS_JSON="$HOOKS_JSON" python3 - <<'PY'
import json, os
script, template_p, target = os.environ["SCRIPT"], os.environ["TEMPLATE"], os.environ["HOOKS_JSON"]
tpl = json.load(open(template_p))
try:
    existing = json.load(open(target))
except Exception:
    existing = {"version": 1, "hooks": {}}
hooks = existing.setdefault("hooks", {})
for event, entries in tpl["hooks"].items():
    lst = hooks.setdefault(event, [])
    if not any("armada-spool.sh" in (e.get("command") or "") for e in lst):
        for e in entries:
            lst.append({**e, "command": e["command"].replace("__SCRIPT__", script)})
json.dump(existing, open(target, "w"), ensure_ascii=False, indent=2)
print("installed: hooks.json merged, script at", script)
PY
