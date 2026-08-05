//! 资源 refill 引擎（从 go-rewrite `internal/sim/refill.go` 移植）。
//!
//! 官方 v0.13 规则：资源每 4 tick 每个 chunk 配额补满
//! max(2, floor(128/(8+ring)))；chunk 32×32；只有视野扫过的格才 reveal；
//! 采空格立即消失。
//!
//! 与 Go 版的有意差异：latent 池与 chunk 分组使用 `BTreeMap`（确定性
//! 迭代）。Go 版 refill 曾存在 map 迭代序导致评分漂移的已知问题
//! （见 Go 源码注释"实测缺失"）；Rust 版按坐标排序恢复，完全确定。

use arena_sim_domain::{cell_key, Position, TickState};
use std::collections::BTreeMap;

use super::vision::in_union_vision;

/// refill 周期（官方 4 tick）。
pub const REFILL_EVERY_TICKS: i32 = 4;
/// chunk 边长（官方 32）。
pub const CHUNK_SIZE: i32 = 32;

/// 潜在资源格的可见性状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefillState {
    /// 可被视野 reveal。
    Active,
    /// 刚被采空，refill 前不可见。
    Mined,
}

/// 潜在资源格（服务器秘密池的模拟条目）。
#[derive(Debug, Clone)]
pub struct RefillCell {
    pub position: Position,
    pub state: RefillState,
}

/// 资源 refill 引擎配置（跨 tick 有状态；单写者使用，与 runtime Loop
/// 一致）。Engine 默认不启用。
#[derive(Debug)]
pub struct RefillConfig {
    /// 补满周期（官方 4）。
    pub every_ticks: i32,
    /// chunk 边长（官方 32）。
    pub chunk_size: i32,
    /// 潜在资源格全集（确定性迭代）。
    pub latent: BTreeMap<String, RefillCell>,
    /// 上次 refill 的 tick。
    pub last_refill: i32,
}

impl RefillConfig {
    /// 构造 refill 配置：latent_cells 是潜在资源格全集（模拟服务器秘密
    /// 分布；通常按 chunk 配额构造）。
    pub fn new(latent_cells: &[Position]) -> RefillConfig {
        let mut config = RefillConfig {
            every_ticks: REFILL_EVERY_TICKS,
            chunk_size: CHUNK_SIZE,
            latent: BTreeMap::new(),
            last_refill: 0,
        };
        for &pos in latent_cells {
            config.latent.insert(
                cell_key(pos[0], pos[1]),
                RefillCell {
                    position: pos,
                    state: RefillState::Active,
                },
            );
        }
        config
    }

    /// 返回格所在 chunk 的原点（floor 对齐到 chunk 网格；div_euclid =
    /// Go math.Floor(float64(c)/size)*size 语义，负坐标一致）。
    fn chunk_origin(&self, position: Position) -> Position {
        let origin = |coord: i32| coord.div_euclid(self.chunk_size) * self.chunk_size;
        [origin(position[0]), origin(position[1])]
    }

    /// 返回 chunk 的 Chebyshev 环（距世界原点）。
    fn ring(&self, origin: Position) -> i32 {
        origin[0].abs().max(origin[1].abs()) / self.chunk_size
    }

    /// 返回 chunk 的 refill 配额（官方公式）。
    fn chunk_quota(&self, origin: Position) -> i32 {
        let quota = 128 / (8 + self.ring(origin));
        quota.max(2)
    }

    /// 把视野内的 active 潜在格加入 ResourceCells（视野揭示语义）。
    fn reveal(&self, state: &mut TickState) {
        for (key, cell) in &self.latent {
            if cell.state != RefillState::Active {
                continue;
            }
            if !in_union_vision(state, cell.position) {
                continue;
            }
            state.resource_cells.insert(key.clone());
        }
    }

    /// 每 every_ticks 把已采空格恢复为 active（chunk 配额内），模拟服务器
    /// 补满配额。确定性：chunk 按原点升序、mined 格按坐标升序恢复。
    fn refill(&mut self, _state: &TickState) {
        // chunk 分组（BTreeMap：原点升序确定性迭代）。
        let mut by_chunk: BTreeMap<Position, Vec<String>> = BTreeMap::new();
        for (key, cell) in &self.latent {
            let origin = self.chunk_origin(cell.position);
            by_chunk.entry(origin).or_default().push(key.clone());
        }
        for (origin, keys) in by_chunk {
            let quota = self.chunk_quota(origin);
            let mut active_count = 0;
            let mut mined: Vec<String> = Vec::new();
            for key in &keys {
                if self.latent[key].state == RefillState::Active {
                    active_count += 1;
                } else {
                    mined.push(key.clone());
                }
            }
            // 补到配额：mined 格按坐标升序恢复（确定性，x 优先）。
            mined.sort_by_key(|key| {
                let cell = &self.latent[key];
                (cell.position[0], cell.position[1])
            });
            for key in mined {
                if active_count >= quota {
                    break;
                }
                self.latent.get_mut(&key).unwrap().state = RefillState::Active;
                active_count += 1;
            }
        }
        let _ = _state; // 只用 latent 状态，不读 state
    }

    /// 记录采空格（harvest 成功后调用；服务器语义：采空格立即消失，
    /// refill 前不可见）。
    pub fn mark_mined(&mut self, position: Position) {
        if let Some(cell) = self.latent.get_mut(&cell_key(position[0], position[1])) {
            cell.state = RefillState::Mined;
        }
    }

    /// Settle 末尾的资源刷新钩子：refill 每 every_ticks 执行（以 next.Tick
    /// 为当前 tick），reveal 每 tick 执行——先补满再揭示：服务器补满配额的
    /// 同 tick，视野内的格立即可见。
    pub fn apply_refill_and_reveal(&mut self, state: &mut TickState) {
        if state.tick % self.every_ticks == 0 && state.tick > self.last_refill {
            self.refill(state);
            self.last_refill = state.tick;
        }
        self.reveal(state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state_with_vision_core(position: Position) -> TickState {
        TickState {
            tick: 1,
            status: arena_sim_domain::CoreStatus::Active,
            resources: 0,
            resource_capacity: 10,
            resource_space: 10,
            population: 1,
            population_tier: 0,
            upkeep_next_tick: 0,
            core: Some(arena_sim_domain::Core {
                id: "core-1".to_string(),
                position,
                hp: 5,
                shield: 5,
                state: arena_sim_domain::CoreState::Normal,
                owner_username: String::new(),
            }),
            units: Vec::new(),
            workers: Vec::new(),
            vanguards: Vec::new(),
            rangers: Vec::new(),
            visible_enemies: Vec::new(),
            resource_cells: Default::default(),
            obstacle_cells: Default::default(),
            beacon: arena_sim_domain::Beacon {
                position: [0, 0],
                status: arena_sim_domain::BeaconStatus::Ground,
                carrier_id: None,
            },
            events: Vec::new(),
            state_hash: String::new(),
        }
    }

    #[test]
    fn chunk_origin_floors_negative_coords() {
        let config = RefillConfig::new(&[]);
        assert_eq!(config.chunk_origin([-17, 77]), [-32, 64]);
        assert_eq!(config.chunk_origin([38, -5]), [32, -32]);
    }

    #[test]
    fn ring_and_quota() {
        let config = RefillConfig::new(&[]);
        assert_eq!(config.ring([0, 0]), 0);
        assert_eq!(config.chunk_quota([0, 0]), 16); // floor(128/8)
        assert_eq!(config.chunk_quota([32, 0]), 14); // floor(128/9)
    }

    #[test]
    fn reveal_only_visible_active_cells() {
        let latent = vec![[0, 0], [3, 3], [100, 100]];
        let mut config = RefillConfig::new(&latent);
        let mut state = state_with_vision_core([0, 0]);
        config.reveal(&mut state);
        assert!(state.resource_cells.contains("0,0"));
        assert!(state.resource_cells.contains("3,3"));
        assert!(!state.resource_cells.contains("100,100"));
    }

    #[test]
    fn mined_cells_restore_deterministically() {
        // 同一 chunk 内 4 个 mined 格、配额 16 → 全部恢复（tick 4 = refill 周期）。
        let latent = vec![[0, 0], [0, 1], [1, 0], [1, 1]];
        let mut config = RefillConfig::new(&latent);
        for pos in &latent {
            config.mark_mined(*pos);
        }
        let mut state = state_with_vision_core([0, 0]);
        state.tick = 4; // refill 每 4 tick 执行
        config.apply_refill_and_reveal(&mut state);
        for pos in &latent {
            assert_eq!(
                config.latent[&cell_key(pos[0], pos[1])].state,
                RefillState::Active
            );
        }
    }
}
