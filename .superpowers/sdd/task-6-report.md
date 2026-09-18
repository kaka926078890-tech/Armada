# Task 6 Report: iOS 快捷提示词

- 日期：2026-09-18
- 状态：完成，按要求未推送
- Commit：`ed2cdeae4c00837b3deb98c66627f6bcf9b9909c`
- Message：`feat: iOS prompt snippets on dispatch and settings`
- 分支：`master`

## 0. TL;DR

| 项 | 内容 |
| --- | --- |
| 问题 | iOS 派发/续聊不能使用快捷提示词，设置页不能编辑词库 |
| 核心方案 | `Session` 内存持有 `[PromptSnippet]`；仅通过 `GET/PUT /mobile/prompt-snippets` 同步；`DispatchSheet` 复用胶囊与添加表单；设置页逐行保存/删除 |
| 关键约束 | JS `trimEnd` 对齐；GET 失败清空；PUT 失败回滚；解绑清空；不使用 UserDefaults |
| 明确不做 | 不新增 XCTest harness；不修改 imageMarkers/chatView 脏文件；不访问任何 ui-prefs 路由；不推送 |

## 1. 背景与需求

| 原始诉求 | 设计映射 | 验收 |
| --- | --- | --- |
| 独立移动 API | `RelayAPI.promptSnippets/putPromptSnippets` 仅访问 `/mobile/prompt-snippets` | `rg ui-prefs mobile/ios` 无命中 |
| 四个错误码中文 | `RelayAPIError.operatorMessage` 增加精确映射，保留 `INVALID` 原文 | 源码核对、iOS 构建 |
| 派发与续聊胶囊 | 共用 `DispatchSheet` 的 `PromptSnippetChips`，位于主 `TextEditor` 上方 | 两条入口自动覆盖 |
| `+` 添加、胶囊不删除 | 胶囊仅追加正文；`+` 展开标题/提示词表单；30 条禁用 | 源码核对 |
| 设置逐行保存/删除 | `PromptSnippetSettingsRow` 独立编辑、保存、删除、行级错误 | 源码核对 |
| 内存与失败语义 | `Session.snippets`；解绑清空；GET 失败清空；PUT 乐观更新后失败回滚 | 源码核对 |
| Settings 注入 Session | `SettingsView` 声明 `@EnvironmentObject var session`，继承 App 根注入 | iOS 构建 |

## 2. 现状盘点

| 可复用能力 | 需新建能力 |
| --- | --- |
| `RelayAPI` Bearer GET/通用 send 与错误分类 | `PromptSnippet` DTO 与 GET/PUT 包装 |
| `Session.api()` 与根级 environmentObject | Session 片段加载、保存、回滚 |
| 派发/续聊共用 `DispatchSheet` | 胶囊栏、添加表单、追加函数 |
| `SettingsView` 外观和字号区 | 快捷提示词区与逐行编辑 |

## 3. 设计原则

1. 单一远端边界：片段只走 `/mobile/prompt-snippets`。
2. 单一内存所有者：所有界面读写 `Session.snippets`。
3. 失败可恢复：GET 不展示陈旧值；PUT 恢复调用前快照。
4. 输入不隐式发送：胶囊只写入草稿，仍由操作员点击派发/发送。
5. 服务端负责统一校验：客户端展示精确错误码文案，不复制长度规则。

备选方案：用 UserDefaults 离线缓存。未选，因为会跨舰队泄漏旧词库，并违反服务端为唯一真源的约束。

## 4. 数据模型 / 接口契约

| 契约 | 内容 |
| --- | --- |
| DTO | `PromptSnippet { id, title, body }`，`Codable/Equatable/Identifiable` |
| GET | `/mobile/prompt-snippets` → `{ snippets: [...] }` |
| PUT | `/mobile/prompt-snippets`，body/response 均为 `{ snippets: [...] }` |
| 错误 | `SNIPPET_INVALID`、`SNIPPET_LIMIT`、`READ_FAIL`、`WRITE_FAIL` 使用 brief 精确中文 |
| 兼容 | `INVALID` 保持“推送登记失败”；不引入 UserDefaults key |
| 上限 | `+` 在 30 条时禁用；服务端仍是最终 gate |

备选方案：复用 `/api/ui-prefs` 或 `/mobile/ui-prefs`。未选，因为移动端契约明确禁止，且会扩大偏好数据暴露面。

## 5. 运行时链路

```text
打开 DispatchSheet / SettingsView
  → Session.loadSnippets()
  → GET /mobile/prompt-snippets
  → 成功替换内存 / 失败清空并设置 READ_FAIL 文案

胶囊点击 → appendSnippetBody(草稿, body) → 不自动发送

添加 / 保存 / 删除
  → 保存 previous 快照 → 内存乐观更新
  → PUT /mobile/prompt-snippets
  → 成功采用服务端返回列表
  → 失败恢复 previous，并显示错误
```

缓存策略：仅 Session 生命周期内存，无磁盘 TTL。失效策略：每次打开相关界面重新 GET；解绑立即清空。降级：读取失败仍可手工输入和派发。

## 6. 安全与威胁模型

| 威胁 | 缓解 |
| --- | --- |
| 跨舰队残留 | 解绑清空内存；不落 UserDefaults |
| 越权访问偏好 | 复用现有 Bearer 授权，只访问 mobile 专用路由 |
| 保存失败导致假成功 | PUT 失败回滚，并显示服务端/传输错误 |
| 绕过条数或字段限制 | 服务端校验为最终边界；客户端仅做 30 条 UX gate |

边界外风险：本任务未增加离线队列；断网时编辑不会持久化。审计沿用 Hub 的 prompt-snippets 写入审计。

## 7. 实施路线图

| Phase | 内容 | 验收 / Gate |
| --- | --- | --- |
| v1（本任务） | API、Session、派发/续聊、设置页 | 模拟器 Debug 构建成功；静态约束全通过 |
| v1.5 | 若项目建立 iOS XCTest target，再补纯函数与回滚单测 | 触发条件：仓库加入可运行测试 target |
| v2 | 无计划 | 不以模糊“后续优化”扩展本任务 |

发布顺序：依赖已落地的 Hub API、Relay mobile 路由后再发布 iOS；当前 master 已按 Task 1–5 顺序包含依赖提交。

## 8. 风险与未决

| 风险 | 影响 | 应对 / 状态 |
| --- | --- | --- |
| 无现成 XCTest target | 追加与回滚缺独立自动化单测 | 已用完整 iOS 编译和源码 gate 验证；非阻塞 |
| `lastError` 为 Session 共享字段 | 设置区可能短暂显示最近一次片段错误 | 成功 GET/PUT 会清空；接受 |
| 未做真机 UI 点击 | 视觉间距与键盘体验未实机验收 | 不阻塞编译交付；发布前由 iOS 真机 smoke gate 覆盖 |

## 9. 验证证据

| 检查 | 结果 |
| --- | --- |
| `xcodebuild ... -sdk iphonesimulator ... build` | `BUILD SUCCEEDED` |
| `git diff --check` | 通过 |
| `rg -n "ui-prefs" mobile/ios` | 无命中 |
| RelayAPI `/mobile/prompt-snippets` 出现次数 | 2（GET、PUT） |
| snippets UserDefaults 静态检查 | 无命中 |
| IDE lints | 目标三个 Swift 文件无错误 |

## 10. 评审检查清单

- [x] 覆盖派发和续聊
- [x] 胶囊在主 TextEditor 上方，且无删除入口
- [x] `+` 可添加，30 条禁用
- [x] 设置页逐行保存/删除与精确空文案
- [x] GET 失败清空并显示错误
- [x] PUT 失败恢复调用前列表
- [x] 解绑清空，无 UserDefaults key
- [x] 不含 ui-prefs 路径
- [x] 未触碰三份既有脏文件
- [x] 已提交、未推送

## 11. 修订记录

| 日期 | 变更 |
| --- | --- |
| 2026-09-18 | 覆盖旧同名报告，记录本轮 iOS prompt snippets Task 6 实现与验证 |

## 12. Task 6 评审修复证据

| 检查 | 结果 |
| --- | --- |
| 修复前源码回归门禁 | 预期失败：解绑世代保护、Unicode `trimEnd`、添加表单“提示词”标签均未满足 |
| 修复后源码回归门禁 | 3/3 通过 |
| Swift Unicode 行为检查 | 通过：尾部 NBSP、EM SPACE、IDEOGRAPHIC SPACE、LINE SEPARATOR 被移除；开头 EM SPACE 保留 |
| `xcodebuild -project mobile/ios/ArmadaRemote.xcodeproj -scheme ArmadaRemote -configuration Debug -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO build` | `BUILD SUCCEEDED` |
| `git diff --check` | 通过 |
| IDE lints（`ArmadaRemoteApp.swift`、`Screens.swift`） | 无错误 |

修复内容：snippet GET/PUT 在 await 后按独立 `snippetsSeq` 校验绑定世代，解绑或重新绑定后的旧结果不再写回；追加正文按 `Character.isWhitespace` 仅裁剪尾部；添加表单补齐“提示词”标签。评审修复仍按要求不推送，且未暂存三份既有无关脏文件。
