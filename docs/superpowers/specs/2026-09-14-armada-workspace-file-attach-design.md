# Armada 工作区文件附件（图片路径保持不变）

> 状态：**需求方向封口；Cursor 3.18.25 / CDP 9222 真机探针已过；可落地。**  
> 日期：2026-09-14  
> 父文档：[2026-09-02-armada-composer-image-chip-design.md](./2026-09-02-armada-composer-image-chip-design.md)

---

## 0. TL;DR

| 项 | 内容 |
| --- | --- |
| 问题 | 中台只能传 PNG/JPEG。文件没有系统剪贴板芯片；回形针 `accept` 只有 `image/*,application/pdf`。 |
| 核心方案 | **图片维持现网芯片。** 其它白名单文件：hub blob → 被控仓 `.armada/inbox/<runId>/` → CDP `@` 菜单点出 `span.mention[data-typeahead-type=file]` → 再插 prompt、回车。 |
| 关键约束 | 图：芯片数 = 图片数。文件：mention 数 = 文件数。失败不降级裸路径、不改根 `.gitignore`。体积仍 4 / 8 MiB / 24 MiB。 |
| 明确不做 | 文件走 OS 剪贴板；点回形针；GIF/WebP 当图；iOS/中转 blobs；自动改用户 `.gitignore`；可执行文件。 |

---

## 1. 背景与需求

| # | 原始诉求 | 设计映射 |
| --- | --- | --- |
| R1 | 支持文件上传 | 派发/续聊可选白名单文件，与图合计最多 4 |
| R2 | 最少侵入且可行 | 不进仓的剪贴板对文件无效（探针已证）；文件才写 inbox |
| R3 | 图片保持原样 | PNG/JPEG 仍 OS 剪贴板 + `.context-pill-image` |
| R4 | 长期有效 | 工作区 `@` 是 Cursor 一等能力；选择器坏了只重探针 |

---

## 2. 现状盘点

| 类别 | 内容 |
| --- | --- |
| 可复用 | `POST /api/blobs`、`runs.attachments`、CDP 锁、图芯片管线、控制台多选 |
| 需新建 | blob 非图白名单 + 原始文件名；inbox 落盘；`@` 菜单点击；文件 mention 计数 |
| 不复用 | 把所有附件当图（`executor.injectImages`）；`mergeImageFiles` 只认 png/jpeg |

### 2.1 真机探针（2026-09-14，本机 Cursor 3.18.25）

| 项 | 结果 |
| --- | --- |
| 文件剪贴板 Cmd+V | 只出现文件名文本，无芯片 |
| 一次 `insertText` 整段 `@路径` | 普通文本，无 mention |
| 先 `@` 再文件名，点菜单 | `span.mention[data-typeahead-type=file]` |
| PDF / 两个 txt / 图+文件同框 | 均可出对应芯片（图 `.context-pill-image`，文件 `.mention`） |
| 新对话回车 | 助手 `Read` inbox 文件，回复 `ACK_PROBE_OK PROBE_FILE_ATTACH_20260914`（[探针对话](8aa0aa43-94dd-424a-ab4f-fa96192b8f38)） |
| 隐藏 file input | `accept="image/*,application/pdf"`，txt 的 `setFileInputFiles` 无新附件 |

---

## 3. 设计原则

1. **按 mime 分叉，禁止把文件当图贴。**
2. **成功标准是 DOM 计数，不是 prompt 字符串里有 `@`。**
3. **图片路径零变化**（含 `armada.imagePaste`、失败码、禁止 `@` 降级）。
4. **inbox 按 runId 隔离。** 不改根 `.gitignore`。
5. **`imagePaste=false` 只拒带图任务**；纯文件仍可派。
6. **失败立刻 `run.ack rejected`，不回车。**

### 3.1 已否决

| 方案 | 为什么不选 |
| --- | --- |
| 文件 OS 剪贴板 | 探针：只贴文件名 |
| 回形针 / `setFileInputFiles` | accept 非通用；图文已否决点回形针 |
| 工作区随意落盘 + 裸 `@路径` 当成功 | 不是 mention；与图文「芯片不够不回车」不一致 |
| 默认改根 `.gitignore` | 额外改仓 |

---

## 4. 数据模型 / 接口契约

实现位置：`hub/src/blobs.ts`、`hub/src/db.ts`、`hub/src/index.ts`、`hub/web/src/attachments.ts`、`extension/src/workspaceInbox.ts`、`extension/src/cdpInject.ts`、`extension/src/executor.ts`。

### 4.1 Blob

| 项 | 契约 |
| --- | --- |
| 图片 | 仍 magic PNG/JPEG；不写工作区 |
| 文件 | 扩展名白名单：`pdf txt md json csv xml yaml yml html htm log`；PDF 另认 `%PDF` |
| 文件名 | `blobs.name` 存原始（sanitize 后）名；`metas()` 必须带回，供 inbox 落盘 |
| 体积/张数/限流/TTL | 与图文 v1 相同：8 MiB、4、24 MiB、10/分钟、并发 2、refcount 24h |
| 拒 | gif/webp/exe 等 → `ATTACHMENT_INVALID_MIME` |

`run.start` / `run.followup` 的 `attachments[]` 继续带 `id, sha256, mime, size, name`。

### 4.2 落盘

`<workspace>/.armada/inbox/<runId>/<sha256前8位>-<safeName>`

- 续聊同一 `runId` 目录。
- 不自动删（对话中 Agent 还要 `Read`）；blob TTL 与仓内残留允许并存。v1.5 再扫 inbox。
- 不改根 `.gitignore`。

### 4.3 注入顺序

1. `composer.createNew` / `openComposer`
2. 有图：现网贴图（**不**插 prompt、**不**回车）
3. 有文件：拉 blob → 落 inbox → 对每个文件：`@` + 唯一文件名 → 点击菜单含该文件名的项 → `span.mention[data-typeahead-type=file]` 计数 = i+1
4. 插 prompt（可空）
5. 若 `autoSubmit`：Enter（沿用 `COMPOSER_ENTER_JS`，框上可同时有图芯片与文件 mention）

失败码：图 `IMAGE_PASTE_FAILED`；文件 `FILE_MENTION_FAILED`（含落盘失败）。

### 4.4 控制台

`accept` 扩到图 + 白名单扩展。`mergeAttachmentFiles` 替换只认图的合并。第 5 个起列表拒收。空 prompt 仍允许只附图/文件。

卡片空标题：`[N 个附件]`（不再假定全是图）。

### 4.5 发布顺序

**hub（blob 白名单 + name）→ 扩展（落盘 + @ 菜单）→ 控制台选文件。**  
旧扩展收到非图附件会走贴图并 `IMAGE_PASTE_FAILED`（接受，与图文 Q4 相同）。扩展升到带本能力的版本。

---

## 5. 运行时链路

```text
控制台 POST /api/blobs（多次）→ POST /api/runs {attachmentIds}
hub → WS run.start {attachments:[{id,mime,name,size}]}
扩展 cdp.lock → 图：剪贴板芯片 / 文件：inbox + @mention
成功 run.ack accepted；失败 rejected，释放注入槽
```

降级：纯文本仍可剪贴板+人工回车。带图失败不降级。带文件失败不降级裸路径。

回滚：停扩控制台非图 `accept`；`armada.imagePaste` 不影响纯文件。

---

## 6. 安全与威胁模型

| 威胁 | 缓解 | 指标 |
| --- | --- | --- |
| 任意二进制进仓 | 扩展名白名单 + PDF magic；拒 exe | 400 `ATTACHMENT_INVALID_MIME` |
| 路径穿越 | `basename` + sanitize，禁止 `..` | 落盘只在 inbox |
| 体积打满 | 8/24 MiB、512 MiB 审计 | 413 |
| 并行覆盖 | `inbox/<runId>/` + sha 前缀 | 同仓并行 4 run |
| 未鉴权拉文件 | 与 REST 相同 Bearer | 401 |

边界外：操作员上传内容合规由中台负责。Agent 能读工作区任何文件（Cursor 既有模型）。

---

## 7. 实施路线图

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| 探针 | 见 §2.1 | **已过** |
| v1 hub | 非图 blob + name | 单测 txt/pdf 201、gif/exe 400 |
| v1 扩展 | inbox + @mention | 单测：纯文件不走贴图；`imagePaste=false` 纯文件可派 |
| v1 控制台 | 混合选择 | 第 5 个拒；pdf 可进列表 |
| v1.5 | inbox 24h 扫描 | 终态 24h 后删目录 |
| v2 | 中转/iOS 上传 | 另开 spec |

上线 gate：macOS 真机 1 txt 派发 → Composer 有文件 mention 且 Agent 能读到 marker；1 张图回归芯片。

---

## 8. 验收

1. 中台选 pdf/txt 派发 → 被控仓出现 inbox 文件，Composer 文件 mention 数 = N，回车后模型能 `Read`。
2. PNG/JPEG 行为与现网一致（芯片、失败码、不进仓）。
3. 图+文件同条：1 个 `.context-pill-image` + 1 个 file mention 再回车。
4. `imagePaste=false` + 仅文件 → 成功；+ 图 → `IMAGE_PASTE_DISABLED`。
5. 单件 >8 MiB 413；第 5 个 UI 拒；exe/gif 400。
6. 文件 mention 不够 **不回车**，`FILE_MENTION_FAILED`。
7. 工作区 git 不因图片变脏；文件仅 `.armada/inbox/<runId>/`。
8. 纯文本回归不变。

---

## 9. 风险与未决

| 项 | 影响 | 应对 | 状态 |
| --- | --- | --- | --- |
| `@` 菜单选择器随 Cursor 改版 | 高 | 计数失败不回车；重探针 | 3.18.25 已过 |
| 同名文件菜单多项 | 中 | 文件名加 sha 前 8 位 | 已锁 |
| 旧扩展假失败 | 中 | 同步升级 | 接受 |
| inbox 残留 | 低 | v1.5 扫描 | 未做 |
| Windows `@` 菜单 | 高 | 发布前补探针；本 v1 先 macOS 真机 gate | 未做 |

阻塞：无（macOS 探针已过）。Windows 不挡 macOS 落地，但 Windows 不得标已验证。

---

## 10. 评审检查清单

- [x] 图片/文件分叉与非目标
- [x] 探针证据（芯片 + 提交 Read）
- [x] 失败码与不降级
- [x] 跨仓发布顺序
- [x] MVP/v1/v1.5 切分
- [ ] Windows 文件 mention 探针

---

## 11. 修订记录

| 日期 | 版本 | 变更 |
| --- | --- | --- |
| 2026-09-14 | 需求 v1 | 文件走工作区 `@` mention；图片保持芯片；剪贴板/回形针否决；真机探针收录 |
