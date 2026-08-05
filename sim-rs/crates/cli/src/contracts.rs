//! 场景/策略/黄金集 JSON 契约（与 Go `cmd/simrun/main.go` 的 sceneFile/
//! policyFile + `cmd/simgolden/main.go` 的 goldenFile 逐字节对齐）。
//!
//! 注意（PARITY.md §7）：现网场景文件（runtime/scenes/*.json）为
//! **PascalCase 大写字段**（Go 因 encoding/json case-insensitive 解析
//! 掩盖了这一点）；Rust serde 必须 `rename_all = "PascalCase"` + 全字段
//! `#[serde(default)]`（OwnerUsername/Vanguards/Rangers/PopulationTier
//! 等经常缺失）。

use std::fs;
use std::path::Path;

use arena_sim_domain::{
    Beacon, BeaconStatus, CellSet, Core, CoreState, CoreStatus, Position, TickState, UnitSnapshot,
    UnitType,
};
use arena_sim_strategy::Config;
use serde::{Deserialize, Serialize};

/// 场景文件（Go `sceneFile`）。
#[derive(Debug, Clone, Deserialize)]
pub struct SceneFile {
    pub name: String,
    pub initial: Option<TickStateJson>,
    #[serde(rename = "latentResources")]
    pub latent_resources: Vec<Position>,
}

/// TickState 的 JSON 镜像（PascalCase + 全字段 default；集合字段用数组）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase", default)]
pub struct TickStateJson {
    pub tick: i32,
    pub status: String,
    pub resources: i32,
    pub resource_capacity: i32,
    pub resource_space: i32,
    pub population: i32,
    pub core: Option<CoreJson>,
    pub units: Vec<UnitSnapshotJson>,
    pub workers: Vec<UnitSnapshotJson>,
    pub vanguards: Vec<UnitSnapshotJson>,
    pub rangers: Vec<UnitSnapshotJson>,
    pub resource_cells: Vec<String>,
    pub obstacle_cells: Vec<String>,
    pub beacon: Option<BeaconJson>,
}

impl Default for TickStateJson {
    fn default() -> Self {
        TickStateJson {
            tick: 1,
            status: "ACTIVE".to_string(),
            resources: 0,
            resource_capacity: 10,
            resource_space: 10,
            population: 0,
            core: None,
            units: Vec::new(),
            workers: Vec::new(),
            vanguards: Vec::new(),
            rangers: Vec::new(),
            resource_cells: Vec::new(),
            obstacle_cells: Vec::new(),
            beacon: None,
        }
    }
}

/// Core 的 JSON 镜像（PascalCase）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase", default)]
pub struct CoreJson {
    pub id: String,
    pub position: Position,
    pub hp: i32,
    pub shield: i32,
    pub state: String,
    pub owner_username: String,
}

impl Default for CoreJson {
    fn default() -> Self {
        CoreJson {
            id: String::new(),
            position: [0, 0],
            hp: arena_sim_domain::CORE_MAX_HP,
            shield: arena_sim_domain::CORE_MAX_SHIELD,
            state: "NORMAL".to_string(),
            owner_username: String::new(),
        }
    }
}

/// 单位快照的 JSON 镜像（PascalCase）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase", default)]
pub struct UnitSnapshotJson {
    pub id: String,
    pub position: Position,
    pub hp: i32,
    pub unit_type: String,
    pub cargo: i32,
}

impl Default for UnitSnapshotJson {
    fn default() -> Self {
        UnitSnapshotJson {
            id: String::new(),
            position: [0, 0],
            hp: 2,
            unit_type: "WORKER".to_string(),
            cargo: 0,
        }
    }
}

/// Beacon 的 JSON 镜像（PascalCase；CarrierID 缺失 = None）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase", default)]
pub struct BeaconJson {
    pub position: Position,
    pub status: String,
    pub carrier_id: Option<String>,
}

impl Default for BeaconJson {
    fn default() -> Self {
        BeaconJson {
            position: [0, 0],
            status: "GROUND".to_string(),
            carrier_id: None,
        }
    }
}

impl TickStateJson {
    /// 转换 JSON 镜像为领域 TickState（与 Go `toTickState` 同语义）。
    pub fn to_tick_state(&self) -> TickState {
        let unit = |u: &UnitSnapshotJson| UnitSnapshot {
            id: u.id.clone(),
            position: u.position,
            hp: u.hp,
            unit_type: parse_unit_type(&u.unit_type),
            cargo: u.cargo,
        };
        let units: Vec<UnitSnapshot> = self.units.iter().map(unit).collect();
        TickState {
            tick: self.tick,
            status: parse_status(&self.status),
            resources: self.resources,
            resource_capacity: self.resource_capacity,
            resource_space: self.resource_space,
            population: self.population,
            population_tier: 0,
            upkeep_next_tick: 0,
            core: self.core.as_ref().map(|c| Core {
                id: c.id.clone(),
                position: c.position,
                hp: c.hp,
                shield: c.shield,
                state: parse_core_state(&c.state),
                owner_username: c.owner_username.clone(),
            }),
            units: units.clone(),
            workers: if self.workers.is_empty() {
                units
                    .iter()
                    .filter(|u| u.unit_type == UnitType::Worker)
                    .cloned()
                    .collect()
            } else {
                self.workers.iter().map(unit).collect()
            },
            vanguards: self.vanguards.iter().map(unit).collect(),
            rangers: self.rangers.iter().map(unit).collect(),
            visible_enemies: Vec::new(),
            resource_cells: self.resource_cells.iter().cloned().collect(),
            obstacle_cells: self.obstacle_cells.iter().cloned().collect(),
            beacon: self
                .beacon
                .as_ref()
                .map(|b| Beacon {
                    position: b.position,
                    status: parse_beacon_status(&b.status),
                    carrier_id: b.carrier_id.clone(),
                })
                .unwrap_or(Beacon {
                    position: [0, 0],
                    status: BeaconStatus::Ground,
                    carrier_id: None,
                }),
            events: Vec::new(),
            state_hash: String::new(),
        }
    }
}

fn parse_unit_type(value: &str) -> UnitType {
    match value {
        "VANGUARD" => UnitType::Vanguard,
        "RANGER" => UnitType::Ranger,
        _ => UnitType::Worker,
    }
}

fn parse_status(value: &str) -> CoreStatus {
    match value {
        "RESPAWNING" => CoreStatus::Respawning,
        _ => CoreStatus::Active,
    }
}

fn parse_core_state(value: &str) -> CoreState {
    match value {
        "MOVING" => CoreState::Moving,
        _ => CoreState::Normal,
    }
}

fn parse_beacon_status(value: &str) -> BeaconStatus {
    match value {
        "CARRIED" => BeaconStatus::Carried,
        _ => BeaconStatus::Ground,
    }
}

/// 策略文件（Go `policyFile`：Config 超集，可省略字段用默认）。
#[derive(Debug, Clone, Deserialize)]
pub struct PolicyFile {
    pub name: Option<String>,
    #[serde(rename = "workerTarget")]
    pub worker_target: Option<i32>,
    #[serde(rename = "populationCeiling")]
    pub population_ceiling: Option<i32>,
    #[serde(rename = "exploreRadius")]
    pub explore_radius: Option<i32>,
    #[serde(rename = "threatDistance")]
    pub threat_distance: Option<i32>,
    #[serde(rename = "spawnReserve")]
    pub spawn_reserve: Option<i32>,
    #[serde(rename = "militaryRatio")]
    pub military_ratio: Option<i32>,
}

impl PolicyFile {
    /// 从策略文件构造 Config（缺省字段用 DefaultConfig；Name 用文件
    /// name 字段或文件名，与 Go loadPolicies 同语义）。
    pub fn to_config(&self, file_name: &str) -> Config {
        let mut config = Config::default();
        if let Some(v) = self.worker_target {
            config.worker_target = v;
        }
        if let Some(v) = self.population_ceiling {
            config.population_ceiling = v;
        }
        if let Some(v) = self.explore_radius {
            config.explore_radius = v;
        }
        if let Some(v) = self.threat_distance {
            config.threat_distance = v;
        }
        if let Some(v) = self.spawn_reserve {
            config.spawn_reserve = v;
        }
        if let Some(v) = self.military_ratio {
            config.military_ratio = v;
        }
        config.name = self
            .name
            .clone()
            .unwrap_or_else(|| strip_json_suffix(file_name));
        config
    }
}

/// 黄金集文件（Go `goldenFile`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoldenFile {
    pub ticks: i32,
    pub policies: Vec<String>,
    pub scenes: Vec<GoldenSnapshot>,
}

/// 单场景黄金快照（Go `goldenSnapshot`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoldenSnapshot {
    pub scene: String,
    pub deposits: i32,
    pub spawns: i32,
    pub workers: i32,
    pub kills: i32,
    #[serde(rename = "unitsLost")]
    pub units_lost: i32,
    pub blocked: i32,
    pub moves: i32,
    pub resources: i32,
}

/// 从 glob 加载场景文件（确定性：文件名排序；与 Go loadScenes 同语义）。
pub fn load_scenes(pattern: &str) -> Result<Vec<(String, SceneFile)>, String> {
    let mut paths: Vec<String> = glob::glob(pattern)
        .map_err(|e| format!("glob {pattern}: {e}"))?
        .filter_map(Result::ok)
        .map(|p| p.display().to_string())
        .collect();
    paths.sort();
    let mut scenes = Vec::with_capacity(paths.len());
    for path in &paths {
        let data = fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))?;
        let mut file: SceneFile =
            serde_json::from_str(&data).map_err(|e| format!("parse {path}: {e}"))?;
        if file.name.is_empty() {
            file.name = strip_json_suffix(
                Path::new(path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default()
                    .as_str(),
            );
        }
        if file.initial.is_none() {
            return Err(format!("{path}: initial state missing"));
        }
        scenes.push((path.clone(), file));
    }
    Ok(scenes)
}

/// 从 glob 加载策略文件（确定性：文件名排序；空 glob 返回空）。
pub fn load_policies(pattern: &str) -> Result<Vec<(String, PolicyFile)>, String> {
    if pattern.is_empty() {
        return Ok(Vec::new());
    }
    let mut paths: Vec<String> = glob::glob(pattern)
        .map_err(|e| format!("glob {pattern}: {e}"))?
        .filter_map(Result::ok)
        .map(|p| p.display().to_string())
        .collect();
    paths.sort();
    let mut policies = Vec::with_capacity(paths.len());
    for path in &paths {
        let data = fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))?;
        let file: PolicyFile =
            serde_json::from_str(&data).map_err(|e| format!("parse {path}: {e}"))?;
        let name = Path::new(&path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        policies.push((name, file));
    }
    Ok(policies)
}

/// 去 .json 后缀（Go `strings.TrimSuffix(base, ".json")`）。
pub fn strip_json_suffix(name: &str) -> String {
    name.strip_suffix(".json").unwrap_or(name).to_string()
}

/// 单元格集合（供其他 CLI 构造场景）。
pub fn cell_set(cells: &[Position]) -> CellSet {
    cells.iter().map(|[x, y]| format!("{x},{y}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_pascal_case_scene_file() {
        let data = r#"{
          "name": "base",
          "initial": {
            "Tick": 1,
            "Status": "ACTIVE",
            "Resources": 10,
            "ResourceCapacity": 10,
            "ResourceSpace": 0,
            "Population": 2,
            "Core": {"ID": "core-1", "Position": [38, 39], "HP": 5, "Shield": 5, "State": "NORMAL"},
            "Units": [{"ID": "w1", "Position": [38, 39], "HP": 2, "UnitType": "WORKER", "Cargo": 1}],
            "ResourceCells": ["38,45"],
            "ObstacleCells": ["36,51"],
            "Beacon": {"Position": [-17, 77], "Status": "GROUND"}
          },
          "latentResources": [[38, 45], [30, 34]]
        }"#;
        let file: SceneFile = serde_json::from_str(data).expect("parse");
        assert_eq!(file.name, "base");
        assert_eq!(file.latent_resources.len(), 2);
        let state = file.initial.unwrap().to_tick_state();
        assert_eq!(state.tick, 1);
        assert_eq!(state.resources, 10);
        assert_eq!(state.core.as_ref().unwrap().position, [38, 39]);
        assert_eq!(state.units[0].unit_type, UnitType::Worker);
        assert_eq!(state.units[0].cargo, 1);
        assert!(state.resource_cells.contains("38,45"));
        assert!(state.obstacle_cells.contains("36,51"));
        assert_eq!(state.beacon.position, [-17, 77]);
        // 缺失字段走默认：分列从 Units 派生（Worker 列非空）。
        assert_eq!(state.workers.len(), 1);
    }

    #[test]
    fn policy_file_defaults() {
        let data = r#"{"name": "aggressive", "workerTarget": 10}"#;
        let file: PolicyFile = serde_json::from_str(data).expect("parse");
        let config = file.to_config("aggressive.json");
        assert_eq!(config.worker_target, 10);
        assert_eq!(config.explore_radius, 17); // 默认
        assert_eq!(config.name, "aggressive");
        // 无 name 字段 → 文件名去后缀。
        let file2: PolicyFile = serde_json::from_str(r#"{"workerTarget": 8}"#).expect("parse");
        assert_eq!(file2.to_config("wt8.json").name, "wt8");
    }

    #[test]
    fn golden_file_roundtrip() {
        let data = r#"{"ticks": 500, "policies": ["default"], "scenes": [{"scene": "base", "deposits": 71, "spawns": 13, "workers": 13, "kills": 0, "unitsLost": 0, "blocked": 1, "moves": 2704, "resources": 4}]}"#;
        let golden: GoldenFile = serde_json::from_str(data).expect("parse");
        assert_eq!(golden.ticks, 500);
        assert_eq!(golden.scenes[0].deposits, 71);
        let serialized = serde_json::to_string(&golden).expect("serialize");
        assert!(serialized.contains("\"unitsLost\""));
    }
}
