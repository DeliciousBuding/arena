@AGENTS.md

Claude Code 必须先读取并遵循根目录 `AGENTS.md`。每次新会话、上下文压缩、切换任务或提交前，重新检查 GitHub Issue #27（迁移总控）与 #26（Pure Rust 实现总控）。

当前硬裁决：Pure Rust 是唯一长期产品主线；Go Host、FFI、Fusion 与 Go fallback 已冻结。若当前 WIP 与该裁决冲突，先停止扩张、保存 patch，并按 `AGENTS.md` 模板在 #27 回执。
