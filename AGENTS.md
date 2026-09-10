# AGENTS.md

只写助手 **该做什么 / 不该做什么**。设计理由见 `docs/` 与父仓 `desk/docs/superpowers/specs/`。

## Cursor rules（本仓权威）

| 文件 | 何时 |
| --- | --- |
| `.cursor/rules/armada-workspace-anchor.mdc` | 总是：目录职责、规格位置、提交切分 |
| `.cursor/rules/armada-durable-boundaries.mdc` | 总是：三把钥匙、followup 不退役 Mac live gen |
| `.cursor/rules/armada-feasibility-before-solution.mdc` | 总是：真机 jsonl/CDP 验证完成前不写方案落地 |
| `.cursor/rules/armada-os-invariants.mdc` | 扩展 / hooks / 桌面 / 停跑 |
| `.cursor/rules/armada-desktop-packaged-verify.mdc` | `desktop/**`：验收=覆盖安装，停 7380 源码 hub |
| `.cursor/rules/armada-quality-gate.mdc` | TS 变更：先跑对应 `bun test` |
| `.cursor/rules/armada-investigate-code-and-logs.mdc` | 总是：先查代码与日志，不默认用户操作失误 |

父仓 `desk/.cursor/rules/long-term-minimal-fixes.mdc`：共享边界一处修；相邻洞列出询问。

## 测试

```bash
bun test hub/test extension/test hooks/test hub/web/test desktop-core/test
```

## 禁止

- 用 prompt / 正文有无推断忙闲或重建骨架
- 为 Intel 单独开停跑分支
- 源码 hub 占 7380 时宣布桌面已验
- 停跑补丁与 LAN discovery 同一提交
