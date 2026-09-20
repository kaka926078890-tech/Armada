---
name: armada-release-docs
description: Use when bumping Armada versions, shipping vsix / overlay / TestFlight / APK, editing README screenshots or the current-version table, or writing release notes. Triggers include 发版, 升版本, changelog, CHANGELOG, README 截图, armada-agent, CURRENT_PROJECT_VERSION, versionName, tauri.conf version.
---

# Armada release docs

升号、打 vsix、overlay、出 TestFlight / APK **同一轮**必须改 README 当前版本表和 `CHANGELOG.md`。只改 `package.json` 不算发完。

权威在 **armada 仓**：`README.md`、`CHANGELOG.md`、本 skill。Desk 工作区只镜像。

## Version sources

读文件，不要猜。README 表里的号必须等于这些文件：

| 面 | 文件 | 字段 |
| --- | --- | --- |
| 扩展 | `extension/package.json` | `version` |
| 桌面 | `desktop/src-tauri/tauri.conf.json`（并与 `desktop/package.json`、`desktop/src-tauri/Cargo.toml` 同号） | `version` |
| iOS | `mobile/ios/ArmadaRemote.xcodeproj/project.pbxproj` | `MARKETING_VERSION` + `CURRENT_PROJECT_VERSION`（TestFlight 号） |
| Android | `mobile/android/app/build.gradle.kts` | `versionName` + `versionCode` |

能力下限（「续聊须 ≥ 0.4.19」）**不是**当前发版。装包句、`armada-agent-*.vsix` 文件名、Windows 拷包步骤改成**当前号**。

## Checklist

改了上表任一字段，或操作员要去装新包时：

1. `CHANGELOG.md`：有新号 → 把 **Unreleased** 搬进带日期的版本节（面 + 号 + 日期）。无新号 → 只追加 Unreleased。
2. 该节必须有 **新增** 和/或 **修复** 列表（操作员能核对的一句话，不要贴 commit subject 堆）。需要装包步骤时加 **操作员注意**。
3. `README.md` 顶部「当前版本」表四行都与权威文件一致；日期改成今天。
4. README 里所有「当前包名 / 请装 / 选中 vsix」跟上当前扩展号。
5. UI 变了操作员能看见：更新 `docs/assets/` 对应图，核对 README `<img src>`。
   - 桌面看板 → `board.png`；详情 → `run-detail.png`；被控 Cursor → `cursor-workspace.png`
   - 手机舰队 / 仓列表 / 详情 → `mobile-fleet.png` / `mobile-workspace.png` / `mobile-run-detail.png`
6. 中台/App 操作员新能力：同一轮问 App 是否看得到（hub `runToSnap`）。见 `armada-hub-app-parity`。
7. 声称桌面验收通过前走 `armada-overlay-verify`。

## CHANGELOG shape

```markdown
## Unreleased
### 新增
- …
### 修复
- …

## YYYY-MM-DD — 扩展 X.Y.Z · iOS TF N · Android A.B.C · 桌面 D.E.F
### 新增
- …
### 修复
- …
### 操作员注意
- …
```

只升一个面：标题里仍写出**此刻四行当前号**（未升的面抄 README 表），避免「只写了 vsix、App 还停在旧号」的假清单。

## Rationalizations

| Excuse | Reality |
| --- | --- |
| 「只是 patch，README 不用动」 | 操作员按 README 装 vsix。号不对就是发错包。 |
| 「CHANGELOG 以后补」 | 以后补 = 没记。Unreleased 也要当场写。 |
| 「commit message 已经说明了」 | commit 不是发版清单。CHANGELOG 面向装包的人。 |
| 「截图还适用」 | 看板列、侧栏、App 五列/详情变了就必须换图。没变才可跳过第 5 步。 |
| 「桌面还是 0.1.0 所以不用写」 | 扩展/App 升了也要改表 + CHANGELOG。桌面号照抄。 |
| 「这是内部 chore」 | `skipped-same-version`、Reload 闩、TF 号都是操作员步骤。要写。 |

## Red flags

- Diff 里有 version / versionName / CURRENT_PROJECT_VERSION，却没有 `README.md` + `CHANGELOG.md`
- README 仍写 `armada-agent-0.4.19.vsix` 而 `extension/package.json` 已经是新号
- CHANGELOG 最新节缺修复/新增，或日期仍是上一轮
- 发版 PR/提交自称完成，但当前版本表有一行对不上文件

**以上任一：停。先补文档再 commit。**
