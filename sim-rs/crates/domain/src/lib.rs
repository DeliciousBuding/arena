//! Arena 模拟器领域模型（从 go-rewrite `internal/domain` 移植）。
//!
//! 语义与 Go/TS 版一致：字段名对齐 TS 版 model.ts；障碍/资源格集合使用
//! cell-key 字符串（"x,y"）。与 Go 版的一个有意差异：集合使用
//! `BTreeSet`（确定性迭代），消除 Go map 迭代序不确定性（Go 版 refill
//! 曾因 map 迭代序导致评分漂移）。

pub mod nav;

// 导航函数 re-export 到 crate 根（Go 版同为 domain 包内函数）。
pub use nav::*;

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

/// 网格坐标 [x, y]（与 Go `Position [2]int` 同构）。
pub type Position = [i32; 2];

/// 返回稳定格键 "x,y"（与 Go `CellKey` 同格式）。
pub fn cell_key(x: i32, y: i32) -> String {
    format!("{x},{y}")
}

/// 解析 "x,y" 格键（与 Go `ParseCellKey` 同语义）。
pub fn parse_cell_key(value: &str) -> Option<Position> {
    let mut parts = value.split(',');
    let x = parts.next()?.parse::<i32>().ok()?;
    let y = parts.next()?.parse::<i32>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some([x, y])
}

/// 集合：cell-key 字符串集合，确定性迭代（BTreeSet）。
pub type CellSet = BTreeSet<String>;

/// 移动/横扫方向（与 Go `Direction` 一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Direction {
    Up,
    Down,
    Left,
    Right,
}

impl Direction {
    pub fn as_str(self) -> &'static str {
        match self {
            Direction::Up => "UP",
            Direction::Down => "DOWN",
            Direction::Left => "LEFT",
            Direction::Right => "RIGHT",
        }
    }

    pub fn valid(self) -> bool {
        true
    }
}

/// 单位类型（与 Go `UnitType` 一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum UnitType {
    Worker,
    Vanguard,
    Ranger,
}

impl UnitType {
    pub fn as_str(self) -> &'static str {
        match self {
            UnitType::Worker => "WORKER",
            UnitType::Vanguard => "VANGUARD",
            UnitType::Ranger => "RANGER",
        }
    }

    pub fn valid(self) -> bool {
        true
    }
}

/// Core 移动状态（与 Go `CoreState` 一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum CoreState {
    Normal,
    Moving,
}

/// 玩家生命周期状态（与 Go `PlayerStatus` 一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum CoreStatus {
    Active,
    Respawning,
}

/// Champion Beacon 状态（与 Go `BeaconStatus` 一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum BeaconStatus {
    Ground,
    Carried,
}

/// 受控单位快照（与 Go `UnitSnapshot` 一致；JSON 形状对齐 Go
/// json.Marshal：PascalCase 字段名）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct UnitSnapshot {
    pub id: String,
    pub position: Position,
    pub hp: i32,
    pub unit_type: UnitType,
    pub cargo: i32,
}

/// 受控 Core 快照（与 Go `Core` 一致；JSON 形状对齐 Go Marshal）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Core {
    pub id: String,
    pub position: Position,
    pub hp: i32,
    pub shield: i32,
    pub state: CoreState,
    pub owner_username: String,
}

/// 可见敌方实体（与 Go `VisibleEntity` 一致）：Kind 为 "UNIT" 或 "CORE"。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct VisibleEntity {
    pub id: String,
    pub kind: String,
    pub position: Position,
    pub hp: i32,
    pub unit_type: Option<UnitType>,
    pub owner_username: Option<String>,
}

/// Champion Beacon 快照（与 Go `Beacon` 一致）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Beacon {
    pub position: Position,
    pub status: BeaconStatus,
    pub carrier_id: Option<String>,
}

/// 单个结算事件快照（与 Go `Event` 一致）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Event {
    pub event_id: String,
    pub tick: i32,
    pub event_type: String,
    pub reason_code: Option<String>,
    pub actor_id: Option<String>,
    pub target_id: Option<String>,
    pub position: Option<Position>,
    pub values: BTreeMap<String, serde_json::Value>,
}

/// 规范化游戏状态（与 Go `TickState` 一致；JSON 形状对齐 Go Marshal：
/// PascalCase 字段名；`resource_cells`/`obstacle_cells` 在 FFI 边界经
/// 镜像类型转换——Go 的 Set 序列化为 `{"x,y":{}}` 对象，BTreeSet 序列化
/// 为数组，见 arena-sim-ffi 契约）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct TickState {
    pub tick: i32,
    pub status: CoreStatus,
    pub resources: i32,
    pub resource_capacity: i32,
    pub resource_space: i32,
    pub population: i32,
    pub population_tier: i32,
    pub upkeep_next_tick: i32,
    pub core: Option<Core>,
    pub units: Vec<UnitSnapshot>,
    pub workers: Vec<UnitSnapshot>,
    pub vanguards: Vec<UnitSnapshot>,
    pub rangers: Vec<UnitSnapshot>,
    pub visible_enemies: Vec<VisibleEntity>,
    pub resource_cells: CellSet,
    pub obstacle_cells: CellSet,
    pub beacon: Beacon,
    pub events: Vec<Event>,
    pub state_hash: String,
}

/// 单位动作类型（与 Go `UnitActionKind` 一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum UnitActionKind {
    Wait,
    Move,
    Harvest,
    Deposit,
    Sweep,
    Shoot,
    PickupBeacon,
    DropBeacon,
    SelfDestruct,
    Heal,
}

/// 单位动作（与 Go `UnitAction` 一致；JSON 形状对齐 Go Marshal）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct UnitAction {
    pub kind: UnitActionKind,
    pub direction: Option<Direction>,
    pub target_id: Option<String>,
    pub expected_cell: Option<Position>,
}

/// Core 动作类型（与 Go `CoreActionKind` 一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum CoreActionKind {
    Wait,
    Spawn,
    RepairShield,
    Heal,
    StartMove,
    CancelMove,
    PickupBeacon,
    DropBeacon,
    SelfDestruct,
}

/// Core 动作（与 Go `CoreAction` 一致；JSON 形状对齐 Go Marshal）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct CoreAction {
    pub kind: CoreActionKind,
    pub unit_type: Option<UnitType>,
    pub direction: Option<Direction>,
}

/// 一次决策的完整动作计划（与 Go `Plan` 一致；JSON 形状对齐 Go
/// Marshal：`{"Tick":N,"UnitActions":{...},"CoreAction":{...},"Intents":{...}}`）。
/// 有意差异：`unit_actions`/`intents` 用 `BTreeMap`（确定性迭代，
/// 等价于 Go 版 sortedUnitIDs 的排序语义）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Plan {
    pub tick: i32,
    pub unit_actions: BTreeMap<String, UnitAction>,
    pub core_action: Option<CoreAction>,
    pub intents: BTreeMap<String, String>,
}

/// 单位与 Core 属性常量（与服务器规则一致，见 Go `plan.go`）。
pub const UNIT_MAX_HP_WORKER: i32 = 2;
pub const UNIT_MAX_HP_VANGUARD: i32 = 4;
pub const UNIT_MAX_HP_RANGER: i32 = 2;
pub const CORE_MAX_HP: i32 = 5;
pub const CORE_MAX_SHIELD: i32 = 5;

/// 单位生成成本（与服务器规则一致）。
pub fn spawn_cost(unit_type: UnitType) -> i32 {
    match unit_type {
        UnitType::Worker => 5,
        UnitType::Vanguard => 10,
        UnitType::Ranger => 12,
    }
}

/// 单位最大 HP。
pub fn unit_max_hp(unit_type: UnitType) -> i32 {
    match unit_type {
        UnitType::Worker => UNIT_MAX_HP_WORKER,
        UnitType::Vanguard => UNIT_MAX_HP_VANGUARD,
        UnitType::Ranger => UNIT_MAX_HP_RANGER,
    }
}
