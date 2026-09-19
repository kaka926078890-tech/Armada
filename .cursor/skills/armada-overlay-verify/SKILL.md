---
name: armada-overlay-verify
description: Overlay-install Armada.app, restore the fleet without waiting for a click, notify the operator, and schedule vsix idle Reload outside the Cursor process tree. Use after tauri build, 覆盖安装, 创建舰队, packaged verify, or when hub UI must be accepted on /Applications/Armada.app while the operator may be away from the Mac.
---

# Armada overlay verify

Acceptance is **overlay-installed `/Applications/Armada.app`**, then a **spawned bundled sidecar**. Not `tauri dev`. Not a source hub on 7380.

## Do this every overlay

1. Quit Armada.app. Stop source hub: `launchctl unload ~/Library/LaunchAgents/com.armada.hub.plist` (ignore missing). Confirm **7380 is free**.
2. `cd armada/desktop && bun run tauri build`
3. `ditto` the bundle onto `/Applications/Armada.app`
4. `open /Applications/Armada.app`
5. Wait until `lsof -nP -iTCP:7380 -sTCP:LISTEN` shows **`/Applications/Armada.app/Contents/Resources/bun`**. The desktop shell persists the board in `localStorage` and calls `restoreOwnedHub()` even when that session is missing (Mac create path) — **do not wait for a click on 创建舰队**.
6. Notify:

```bash
osascript -e 'display notification "中台已覆盖安装并拉起" with title "Armada"'
```

7. If this pack **installed a newer vsix** (`ok`, not `skipped-same-version`), schedule Reload **outside Cursor’s process tree** (never `nohup` from the agent terminal):

```bash
python3 - <<'PY'
import subprocess, pathlib
script = pathlib.Path("/Users/apple/Desktop/desk/armada/desktop/scripts/schedule-cursor-reload.sh")
subprocess.Popen(
    ["bash", str(script), "when-idle"],
    start_new_session=True,
    cwd="/",
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
PY
```

That script `trap '' HUP`, POSTs `/api/cursor-reload` `{action:"when-idle"}` (or writes `~/.armada/pending-reload.json` using `extension/package.json` version), then notifies. After **0.4.27**, the extension reloads **per window** when that window has **no Armada live run** (`when-idle`) or immediately (`now`). 15 minutes still busy → notify, do not force.

Chicken-egg: **0.4.26 and older do not poll** `pending-reload.json`. The first jump to 0.4.27 still needs one operator **Reload Window** (or a window already on 0.4.27). After that, idle Reload is automatic.

8. Tell the operator in chat: overlay spawned, notification sent. Failures get a failure notification too.

## Forbidden

- Attach a source hub on 7380 and call it packaged verify
- Click-automation on 创建舰队 as the restore path
- `workbench.action.reloadWindow` or `cursor` CLI from a child of Cursor
- Reloading when vsix did not change
- Claiming desktop acceptance before 7380 is the bundled bun

## Operator controls (hub + App)

Banner when `needed`: **现在 Reload** / **空闲后自动** / **这次跳过**. Overlay skill uses **空闲后自动**.
