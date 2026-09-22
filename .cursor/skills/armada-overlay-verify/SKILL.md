---
name: armada-overlay-verify
description: Overlay-install Armada.app, restore the fleet without waiting for a click, notify the operator, and schedule vsix idle Reload outside the Cursor process tree. Use after tauri build, 覆盖安装, 创建舰队, packaged verify, or when hub UI must be accepted on /Applications/Armada.app while the operator may be away from the Mac.
---

# Armada overlay verify

Acceptance is **overlay-installed `/Applications/Armada.app`**, then a **spawned bundled sidecar**. Not `tauri dev`. Not a source hub on 7380.

## Do this every overlay

1. Quit Armada.app. Stop source hub: `launchctl unload ~/Library/LaunchAgents/com.armada.hub.plist` (ignore missing). Confirm **7380 is free**.
2. `cd armada/desktop && bash scripts/tauri-build.sh`（稳定开发证书，禁止 `signingIdentity: "-"`。ad-hoc 每次 overlay 都会重弹 TCC「允许访问桌面」，系统框不能代点。）
3. `ditto` the bundle onto `/Applications/Armada.app`
4. `open /Applications/Armada.app`
5. Wait until `ps -ww -p "$(lsof -t -nP -iTCP:7380 -sTCP:LISTEN)" -o args=` contains **`/Applications/Armada.app/Contents/Resources/bun`**. `lsof` COMMAND is just `bun` — do not match the bundle path on that column. The desktop shell persists the board in `localStorage` and calls `restoreOwnedHub()` even when that session is missing (Mac create path) — **do not wait for a click on 创建舰队**.
6. Notify:

```bash
osascript -e 'display notification "中台已覆盖安装并拉起" with title "Armada"'
```

7. Unpack the bundled vsix into Cursor's extensions dir **before** any Reload pending. Use the script in the repo you just built (not a hardcoded path, not `cursor --install-extension`):

```bash
python3 desktop/scripts/unpack-cursor-vsix.py \
  "/Applications/Armada.app/Contents/Resources/armada-agent-<version>.vsix"
```

`<version>` is `extension/package.json`. The script prints one line:

- `ok <version>` — `~/.cursor/extensions/armada.armada-agent-<version>` exists and `extensions.json` identifier `armada.armada-agent` points at it. Schedule Reload.
- `skipped-same-version <installed>` — do not schedule Reload.
- anything else, or exit ≠ 0 — do **not** write `~/.armada/pending-reload.json`. Notify the failure. A pending whose folder is missing makes the extension log `missing` every 10s; after 15 minutes of a busy window it logs `expired` and still will not Reload.

The desktop app unpacks on the same path when it creates or restores the fleet (macOS, Linux, and Windows). This step still runs: `finish_create` discards the install result, and a pending written first is the failure this skill is here to prevent.

Only after `ok`, schedule Reload **outside Cursor’s process tree** (never `nohup` from the agent terminal). `SCHEDULE` is `desktop/scripts/schedule-cursor-reload.sh` in that same repo:

```bash
python3 - <<'PY'
import subprocess, pathlib
script = pathlib.Path("<armada-repo>/desktop/scripts/schedule-cursor-reload.sh")
subprocess.Popen(
    ["bash", str(script), "when-idle"],
    start_new_session=True,
    cwd="/",
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
PY
```

That script `trap '' HUP`, POSTs `/api/cursor-reload` `{action:"when-idle"}` (or writes `~/.armada/pending-reload.json` using `extension/package.json` version), then notifies. After **0.4.36**, a window Reloads only when **the pending vsix is already unpacked** under `~/.cursor/extensions`. No local pack → `need-pack`, never `reloadWindow` just because the window is idle. If the pack is present: no Armada live run, no fresh open composer jsonl turn, and no stop/`turn_ended` within 2 minutes (`when-idle`). `now` still ignores Armada pending/bind and the settle grace, but waits for those open jsonl turns. 15 minutes still busy → notify, do not force. The on-disk attempt latch is kept after `reloadWindow` settles.

Spawn 起来 ≠ 功能验收过。对照 `docs/superpowers/specs/2026-09-20-armada-debt-real-device-verify.md`：已过的 vsix 回归不要重派安装提示词；还欠的是 overlay **之后**在 bundled bun 上的短回归（该文 §3）。

Chicken-egg: **0.4.26 and older do not poll** `pending-reload.json`. The first jump to 0.4.27 still needs one operator **Reload Window** (or a window already on 0.4.27). After that, idle Reload is automatic.

8. Tell the operator in chat: overlay spawned, notification sent. Failures get a failure notification too.

## Forbidden

- Attach a source hub on 7380 and call it packaged verify
- Click-automation on 创建舰队 as the restore path
- `workbench.action.reloadWindow` or `cursor --install-extension` from a child of Cursor (install is unpack, on every desktop OS)
- Reloading when vsix did not change
- Claiming desktop acceptance before 7380 is the bundled bun
- 只打 vsix / 只 `Install from VSIX` 就当发完（包装 `REQUIRED_EXTENSION_VERSION` 仍旧号，看板「现在 / 空闲 Reload」会空转）
- overlay 用 `signingIdentity: "-"` ad-hoc 打包（每次覆盖安装都会重弹 TCC）
- 用 Accessibility / osascript 去点「允许访问桌面」系统框

## Operator controls (hub + App)

Banner when `needed`: **现在 Reload** / **空闲后自动** / **这次跳过**. Overlay skill uses **空闲后自动**.
