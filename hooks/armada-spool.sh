#!/bin/sh
# Armada hook spooler: stdin JSON → maildir 原子落盘; stdout 恒 {} 且 exit 0。
# 纯 POSIX sh + sed/awk,不依赖 python/node(SPEC §3 原则 1 / §4.1)。
EVENT="${1:-unknown}"
SPOOL_DIR="${ARMADA_SPOOL_DIR:-$HOME/.cursor/armada/spool}"
mkdir -p "$SPOOL_DIR" 2>/dev/null || true

# Windows Cursor keeps hook stdin open (no EOF). That path is armada-spool.exe.
# This script is macOS/Linux: Cursor closes stdin, so `cat` is correct.
# bash 4 `read -N -t` is only a fallback for Git bash still invoking this .sh.
# Do not use bash 3.2 `read -n`: it stops at newline and `-t` is ignored on a
# still-open pipe, which truncates __unparsed and deadlocks until the hook timeout.
read_hook_stdin() {
  _armada_raw=""
  if IFS= read -r -t 1 -N 262144 _armada_raw 2>/dev/null || [ -n "${_armada_raw:-}" ]; then
    printf '%s' "$_armada_raw"
    return 0
  fi
  cat 2>/dev/null || true
}

RAW=$(read_hook_stdin)
[ -z "$RAW" ] && RAW='{}'

TS=$(date +%s)
RND=$(awk 'BEGIN { srand(); printf "%05d", int(rand() * 100000) }')
ID="${TS}.$$.${RND}"
TMP="$SPOOL_DIR/.${ID}.tmp"
FINAL="$SPOOL_DIR/${ID}.json"

# 将 stdin 字节流转义为 JSON 字符串内容(不含两侧引号)。
json_escape() {
  awk '
    BEGIN { ORS = "" }
    {
      line = $0
      gsub(/\\/, "\\\\", line)
      gsub(/"/, "\\\"", line)
      gsub(/\t/, "\\t", line)
      gsub(/\r/, "\\r", line)
      gsub(/\f/, "\\f", line)
      if (NR > 1) printf "\\n"
      printf "%s", line
    }
  '
}

# 截断到最多 4000 字符(按 awk length; ASCII 下等同字节)。
truncate_4000() {
  awk '
    BEGIN { ORS = "" }
    {
      if (NR > 1) s = s "\n"
      s = s $0
    }
    END {
      if (length(s) > 4000) s = substr(s, 1, 4000)
      printf "%s", s
    }
  '
}

# 形态检测:trim 后以 { } 或 [ ] 包裹则视为可嵌入的 JSON 值。
# 官方 hook stdin 为 compact JSON object;非法输入走 __unparsed。
# 不用 plutil:其对非 JSON 纯文本会误报 OK。
looks_like_json() {
  printf '%s' "$1" | awk '
    BEGIN { ORS = "" }
    { buf = buf $0 }
    END {
      while (match(buf, /^[ \t\r\n]/)) buf = substr(buf, RSTART + RLENGTH)
      while (match(buf, /[ \t\r\n]+$/)) buf = substr(buf, 1, RSTART - 1)
      if (length(buf) < 2) exit 1
      c = substr(buf, 1, 1)
      e = substr(buf, length(buf), 1)
      if ((c == "{" && e == "}") || (c == "[" && e == "]")) exit 0
      exit 1
    }
  '
}

if looks_like_json "$RAW"; then
  RAW_JSON="$RAW"
else
  TRUNC=$(printf '%s' "$RAW" | truncate_4000)
  ESC=$(printf '%s' "$TRUNC" | json_escape)
  RAW_JSON=$(printf '{"__unparsed":"%s"}' "$ESC")
fi

# EVENT 仅允许安全字符,避免破坏外层 JSON。
SAFE_EVENT=$(printf '%s' "$EVENT" | tr -cd 'A-Za-z0-9_.:-')
[ -z "$SAFE_EVENT" ] && SAFE_EVENT="unknown"

{
  printf '{"__hook":"%s","__ts":%s,"__raw":' "$SAFE_EVENT" "$TS"
  printf '%s' "$RAW_JSON"
  printf '}\n'
} >"$TMP" 2>/dev/null || \
  printf '{"__hook":"%s","__ts":%s,"__raw":{"__unparsed":""}}\n' "$SAFE_EVENT" "$TS" >"$TMP" 2>/dev/null || true

[ -f "$TMP" ] && mv "$TMP" "$FINAL" 2>/dev/null || true
echo '{}'
exit 0
