//! CLI 平台共享库（与 Go `internal/sim/batch.go` + `cmd/sim*` 共享契约对偶）。
//!
//! - contracts：scene/policy/golden JSON 序列化（Go 输出格式逐字节对齐）
//! - batch：rayon 并发批量评估（结果确定性排序：scene 名升序 × policy 名升序）
//! - policy_name：策略可读名（Batch 结果排序键）

pub mod batch;
pub mod contracts;
pub mod policy_name;
pub mod rng;

pub use batch::{batch, BatchOption, BatchResult, Scenario, TimelinePoint};
pub use contracts::{
    load_policies, load_scenes, GoldenFile, GoldenSnapshot, PolicyFile, SceneFile,
};
pub use policy_name::policy_name;
pub use rng::SplitMix64;
