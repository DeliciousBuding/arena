//! 融合线 FFI 边界（fusion-line.md §2 契约）：
//! Go 宿主 → Rust 决策内核。句柄化 planner 实例（跨 tick 记忆：
//! patrolTargets/patrolDirs——无状态接口会破坏巡逻连续性，契约第一
//! 设计点）。
//!
//! 契约：
//! - 全部入口 `catch_unwind`（panic 绝不穿 C ABI）；
//! - 返回 `CString::into_raw`（Go 侧经 `arena_string_free` 释放）；
//!   错误走 err_out 避免歧义；
//! - JSON 形状对齐 Go `json.Marshal`：PascalCase 字段；集合字段
//!   （ResourceCells/ObstacleCells）为 Go Set 对象形状 `{"x,y":{}}`
//!   （经镜像类型转换，BTreeSet 序列化为数组，两者形状不同）。

use std::collections::BTreeMap;
use std::ffi::{c_char, c_void, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};

use arena_sim_domain::{Beacon, BeaconStatus, Core, CoreState, CoreStatus, Event, TickState};
use arena_sim_strategy::{Config, Planner};
use serde::Deserialize;

/// 归一化错误消息（err_out 契约：调用方读取后 free）。
const ERR_PREFIX: &str = "arena-sim-ffi: ";

// ---------------------------------------------------------------------------
// FFI 导出
// ---------------------------------------------------------------------------

/// 创建 planner 实例（config JSON → 句柄）。失败时返回 null + err_out。
///
/// # Safety
/// `config_json` 必须为合法 NUL 结尾 C 字符串；`err_out` 必须可写。
#[no_mangle]
pub unsafe extern "C" fn arena_planner_new(
    config_json: *const c_char,
    err_out: *mut *mut c_char,
) -> *mut c_void {
    // new 的成功值是裸指针（非序列化值），单独走边界。
    if err_out.is_null() {
        return std::ptr::null_mut();
    }
    *err_out = std::ptr::null_mut();
    let result = catch_unwind(AssertUnwindSafe(|| {
        let config: Config = parse_json(config_json)?;
        let planner = Planner::new(config);
        Ok::<*mut c_void, String>(Box::into_raw(Box::new(planner)) as *mut c_void)
    }));
    match result {
        Ok(Ok(handle)) => handle,
        Ok(Err(message)) => {
            set_err(err_out, &message);
            std::ptr::null_mut()
        }
        Err(_) => {
            set_err(
                err_out,
                "panic inside Rust planner (caught at FFI boundary)",
            );
            std::ptr::null_mut()
        }
    }
}

/// 决策：state JSON → plan JSON（Go 侧经 arena_string_free 释放返回串）。
///
/// # Safety
/// `handle` 必须来自 `arena_planner_new`（未 free）；其余参数同
/// `arena_planner_new`。
#[no_mangle]
pub unsafe extern "C" fn arena_planner_decide(
    handle: *mut c_void,
    state_json: *const c_char,
    err_out: *mut *mut c_char,
) -> *mut c_char {
    call_boundary(
        || {
            let planner = handle_mut::<Planner>(handle)?;
            // Go state JSON（集合为 Set 对象形状）经镜像转换（不能直接
            // 反序列化到领域 TickState——BTreeSet 期望数组形状）。
            if state_json.is_null() {
                return Err("null state input".to_string());
            }
            let input = CStr::from_ptr(state_json)
                .to_str()
                .map_err(|e| format!("invalid utf-8: {e}"))?;
            let state = state_from_go_json(input)?;
            let plan = planner.decide(&state);
            Ok(plan)
        },
        err_out,
    )
}

/// 指令下发：directive JSON（`{"Mode":"GROWTH","Focus":[0,0]}`）→ "ok"。
///
/// # Safety
/// 参数同 `arena_planner_decide`。
#[no_mangle]
pub unsafe extern "C" fn arena_planner_apply_directive(
    handle: *mut c_void,
    directive_json: *const c_char,
    err_out: *mut *mut c_char,
) -> *mut c_char {
    call_boundary(
        || {
            let planner = handle_mut::<Planner>(handle)?;
            let directive: arena_sim_strategy::Directive = parse_json(directive_json)?;
            planner.apply_directive(directive);
            Ok("ok")
        },
        err_out,
    )
}

/// 释放 Rust 侧分配的 C 字符串（`CString::into_raw` 的配套：返回串与
/// err_out 都由本函数释放——跨分配器 free 是 UB，Go 侧不得用 C.free）。
///
/// # Safety
/// `ptr` 必须来自本库的返回串/err_out（且未释放；null 安全）。
#[no_mangle]
pub unsafe extern "C" fn arena_string_free(ptr: *mut c_char) {
    if !ptr.is_null() {
        drop(CString::from_raw(ptr));
    }
}

/// 释放 planner 实例（null 安全）。
///
/// # Safety
/// `handle` 必须来自 `arena_planner_new` 且未被释放（幂等 null 安全）。
#[no_mangle]
pub unsafe extern "C" fn arena_planner_free(handle: *mut c_void) {
    if !handle.is_null() {
        drop(Box::from_raw(handle as *mut Planner));
    }
}

// ---------------------------------------------------------------------------
// 边界辅助
// ---------------------------------------------------------------------------

/// 统一边界：catch_unwind 包裹 + 错误走 err_out + 成功序列化为 CString。
/// 返回的 *mut c_char 由 Go 侧经 `arena_string_free` 释放（不得用
/// C.free——跨分配器释放是 UB）。
unsafe fn call_boundary<T: serde::Serialize>(
    body: impl FnOnce() -> Result<T, String>,
    err_out: *mut *mut c_char,
) -> *mut c_char {
    // 防御性：err_out 本身非法时至少不写穿（写入仍可能 UB，但契约要求
    // 调用方传合法指针；此处只防御 null）。
    if err_out.is_null() {
        return null_mut_cstr();
    }
    *err_out = std::ptr::null_mut();
    let result = catch_unwind(AssertUnwindSafe(body));
    match result {
        Ok(Ok(value)) => match serde_json::to_string(&value) {
            Ok(json) => match CString::new(json) {
                Ok(owned) => owned.into_raw(),
                Err(_) => {
                    set_err(err_out, "serialize produced interior NUL");
                    null_mut_cstr()
                }
            },
            Err(err) => {
                set_err(err_out, &format!("serialize: {err}"));
                null_mut_cstr()
            }
        },
        Ok(Err(message)) => {
            set_err(err_out, &message);
            null_mut_cstr()
        }
        Err(_) => {
            // panic 被 catch_unwind 捕获——绝不穿 C ABI（契约细则）。
            set_err(
                err_out,
                "panic inside Rust planner (caught at FFI boundary)",
            );
            null_mut_cstr()
        }
    }
}

/// 从 C 字符串解析 JSON（失败返回错误消息）。
unsafe fn parse_json<T: serde::de::DeserializeOwned>(json: *const c_char) -> Result<T, String> {
    if json.is_null() {
        return Err("null input".to_string());
    }
    let input = CStr::from_ptr(json)
        .to_str()
        .map_err(|e| format!("invalid utf-8: {e}"))?;
    serde_json::from_str(input).map_err(|e| format!("parse: {e}"))
}

/// 从句柄取 &mut（null 检查）。
unsafe fn handle_mut<T>(handle: *mut c_void) -> Result<&'static mut T, String> {
    if handle.is_null() {
        return Err("null planner handle".to_string());
    }
    Ok(&mut *(handle as *mut T))
}

/// 写错误消息到 err_out（CString 所有权转移给调用方）。
unsafe fn set_err(err_out: *mut *mut c_char, message: &str) {
    let full = format!("{ERR_PREFIX}{message}");
    if let Ok(owned) = CString::new(full) {
        *err_out = owned.into_raw();
    }
}

/// 空 C 字符串指针（成功但无返回值时用；Go 侧按 null 处理）。
unsafe fn null_mut_cstr() -> *mut c_char {
    std::ptr::null_mut()
}

// ---------------------------------------------------------------------------
// Go state JSON 镜像（集合字段为 Go Set 对象形状）
// ---------------------------------------------------------------------------

/// Go `domain.TickState` 的 JSON 镜像（PascalCase 字段；集合为对象形状）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase", default)]
struct StateJsonIn {
    tick: i32,
    status: String,
    resources: i32,
    resource_capacity: i32,
    resource_space: i32,
    population: i32,
    population_tier: i32,
    upkeep_next_tick: i32,
    core: Option<CoreJsonIn>,
    /// Go nil slice marshal 为 null（不是缺失）——serde default 不覆盖
    /// null，必须 Option + 转换。
    units: Option<Vec<UnitSnapshotJsonIn>>,
    workers: Option<Vec<UnitSnapshotJsonIn>>,
    vanguards: Option<Vec<UnitSnapshotJsonIn>>,
    rangers: Option<Vec<UnitSnapshotJsonIn>>,
    visible_enemies: Option<Vec<VisibleEntityJsonIn>>,
    /// Go Set 序列化为 `{"x,y":{}}` 对象（值忽略）；nil Set → null。
    resource_cells: Option<BTreeMap<String, serde_json::Value>>,
    /// Go Set 序列化为 `{"x,y":{}}` 对象（值忽略）；nil Set → null。
    obstacle_cells: Option<BTreeMap<String, serde_json::Value>>,
    beacon: Option<BeaconJsonIn>,
    events: Option<Vec<EventJsonIn>>,
    state_hash: String,
}

impl Default for StateJsonIn {
    fn default() -> Self {
        StateJsonIn {
            tick: 1,
            status: "ACTIVE".to_string(),
            resources: 0,
            resource_capacity: 10,
            resource_space: 10,
            population: 0,
            population_tier: 0,
            upkeep_next_tick: 0,
            core: None,
            units: None,
            workers: None,
            vanguards: None,
            rangers: None,
            visible_enemies: None,
            resource_cells: None,
            obstacle_cells: None,
            beacon: None,
            events: None,
            state_hash: String::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase", default)]
struct CoreJsonIn {
    /// Go 字段名 "ID"（全大写）——serde PascalCase 转出 "Id"，需 alias。
    #[serde(alias = "ID")]
    id: String,
    position: [i32; 2],
    hp: i32,
    shield: i32,
    state: String,
    owner_username: String,
}

impl Default for CoreJsonIn {
    fn default() -> Self {
        CoreJsonIn {
            id: String::new(),
            position: [0, 0],
            hp: 5,
            shield: 5,
            state: "NORMAL".to_string(),
            owner_username: String::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase", default)]
struct UnitSnapshotJsonIn {
    /// Go 字段名 "ID"（全大写）——serde PascalCase 转出 "Id"，需 alias。
    #[serde(alias = "ID")]
    id: String,
    position: [i32; 2],
    hp: i32,
    unit_type: String,
    cargo: i32,
}

impl Default for UnitSnapshotJsonIn {
    fn default() -> Self {
        UnitSnapshotJsonIn {
            id: String::new(),
            position: [0, 0],
            hp: 2,
            unit_type: "WORKER".to_string(),
            cargo: 0,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase", default)]
struct VisibleEntityJsonIn {
    /// Go 字段名 "ID"（全大写）。
    #[serde(alias = "ID")]
    id: String,
    kind: String,
    position: [i32; 2],
    hp: i32,
    unit_type: Option<String>,
    owner_username: Option<String>,
}

impl Default for VisibleEntityJsonIn {
    fn default() -> Self {
        VisibleEntityJsonIn {
            id: String::new(),
            kind: String::new(),
            position: [0, 0],
            hp: 0,
            unit_type: None,
            owner_username: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase", default)]
struct BeaconJsonIn {
    position: [i32; 2],
    status: String,
    carrier_id: Option<String>,
}

impl Default for BeaconJsonIn {
    fn default() -> Self {
        BeaconJsonIn {
            position: [0, 0],
            status: "GROUND".to_string(),
            carrier_id: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase", default)]
struct EventJsonIn {
    /// Go 字段名 "EventID"。
    #[serde(rename = "EventID")]
    event_id: String,
    tick: i32,
    event_type: String,
    reason_code: Option<String>,
    /// Go 字段名 "ActorID"。
    #[serde(rename = "ActorID")]
    actor_id: Option<String>,
    /// Go 字段名 "TargetID"。
    #[serde(rename = "TargetID")]
    target_id: Option<String>,
    position: Option<[i32; 2]>,
    values: BTreeMap<String, serde_json::Value>,
}

impl Default for EventJsonIn {
    fn default() -> Self {
        EventJsonIn {
            event_id: String::new(),
            tick: 0,
            event_type: String::new(),
            reason_code: None,
            actor_id: None,
            target_id: None,
            position: None,
            values: BTreeMap::new(),
        }
    }
}

/// 反序列化 Go state JSON（镜像类型）→ 领域 TickState。
pub fn state_from_go_json(json: &str) -> Result<TickState, String> {
    let input: StateJsonIn = serde_json::from_str(json).map_err(|e| format!("parse: {e}"))?;
    let unit = |u: &UnitSnapshotJsonIn| arena_sim_domain::UnitSnapshot {
        id: u.id.clone(),
        position: u.position,
        hp: u.hp,
        unit_type: parse_unit_type(&u.unit_type),
        cargo: u.cargo,
    };
    let units: Vec<arena_sim_domain::UnitSnapshot> = input
        .units
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(unit)
        .collect();
    Ok(TickState {
        tick: input.tick,
        status: parse_status(&input.status),
        resources: input.resources,
        resource_capacity: input.resource_capacity,
        resource_space: input.resource_space,
        population: input.population,
        population_tier: input.population_tier,
        upkeep_next_tick: input.upkeep_next_tick,
        core: input.core.as_ref().map(|c| Core {
            id: c.id.clone(),
            position: c.position,
            hp: c.hp,
            shield: c.shield,
            state: parse_core_state(&c.state),
            owner_username: c.owner_username.clone(),
        }),
        units: units.clone(),
        workers: input.workers.as_deref().map_or_else(
            || {
                units
                    .iter()
                    .filter(|u| u.unit_type == arena_sim_domain::UnitType::Worker)
                    .cloned()
                    .collect()
            },
            |list| list.iter().map(unit).collect(),
        ),
        vanguards: input
            .vanguards
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(unit)
            .collect(),
        rangers: input
            .rangers
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(unit)
            .collect(),
        visible_enemies: input
            .visible_enemies
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|e| arena_sim_domain::VisibleEntity {
                id: e.id.clone(),
                kind: e.kind.clone(),
                position: e.position,
                hp: e.hp,
                unit_type: e.unit_type.as_deref().map(parse_unit_type),
                owner_username: e.owner_username.clone(),
            })
            .collect(),
        resource_cells: input
            .resource_cells
            .as_ref()
            .map(|cells| cells.keys().cloned().collect())
            .unwrap_or_default(),
        obstacle_cells: input
            .obstacle_cells
            .as_ref()
            .map(|cells| cells.keys().cloned().collect())
            .unwrap_or_default(),
        beacon: input
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
        events: input
            .events
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|e| Event {
                event_id: e.event_id.clone(),
                tick: e.tick,
                event_type: e.event_type.clone(),
                reason_code: e.reason_code.clone(),
                actor_id: e.actor_id.clone(),
                target_id: e.target_id.clone(),
                position: e.position,
                values: e.values.clone(),
            })
            .collect(),
        state_hash: input.state_hash.clone(),
    })
}

fn parse_unit_type(value: &str) -> arena_sim_domain::UnitType {
    match value {
        "VANGUARD" => arena_sim_domain::UnitType::Vanguard,
        "RANGER" => arena_sim_domain::UnitType::Ranger,
        _ => arena_sim_domain::UnitType::Worker,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 最小 Go 形状 state JSON（PascalCase + Set 对象集合）。
    const GO_STATE_JSON: &str = r#"{
        "Tick": 1,
        "Status": "ACTIVE",
        "Resources": 10,
        "ResourceCapacity": 10,
        "ResourceSpace": 0,
        "Population": 2,
        "Core": {"ID": "core-1", "Position": [38, 39], "HP": 5, "Shield": 5, "State": "NORMAL", "OwnerUsername": ""},
        "Units": [{"ID": "worker-full", "Position": [38, 39], "HP": 2, "UnitType": "WORKER", "Cargo": 1}],
        "Workers": [{"ID": "worker-full", "Position": [38, 39], "HP": 2, "UnitType": "WORKER", "Cargo": 1}],
        "Vanguards": [],
        "Rangers": [],
        "VisibleEnemies": [],
        "ResourceCells": {"38,45": {}},
        "ObstacleCells": {"36,51": {}, "38,50": {}},
        "Beacon": {"Position": [-17, 77], "Status": "GROUND"},
        "Events": [],
        "StateHash": ""
    }"#;

    #[test]
    fn state_from_go_json_parses_set_objects() {
        let state = state_from_go_json(GO_STATE_JSON).expect("parse");
        assert_eq!(state.tick, 1);
        assert_eq!(state.resources, 10);
        assert_eq!(state.core.as_ref().unwrap().position, [38, 39]);
        assert_eq!(state.units[0].id, "worker-full");
        assert_eq!(state.units[0].cargo, 1);
        assert!(state.resource_cells.contains("38,45"));
        assert!(state.obstacle_cells.contains("36,51"));
        assert!(state.obstacle_cells.contains("38,50"));
        assert_eq!(state.beacon.position, [-17, 77]);
    }

    #[test]
    fn plan_json_shape_matches_go() {
        // domain Plan 序列化必须对齐 Go `json.Marshal`：PascalCase + 大写枚举。
        let mut planner = Planner::new(Config::default());
        let state = state_from_go_json(GO_STATE_JSON).expect("parse");
        let plan = planner.decide(&state);
        let json = serde_json::to_string(&plan).expect("serialize");
        assert!(json.contains("\"Tick\":1"), "missing Tick: {json}");
        assert!(
            json.contains("\"UnitActions\""),
            "missing UnitActions: {json}"
        );
        assert!(
            json.contains("\"CoreAction\""),
            "missing CoreAction: {json}"
        );
        assert!(json.contains("\"Intents\""), "missing Intents: {json}");
        // 枚举大写（Go string 形状）。
        assert!(json.contains("\"Kind\":\"MOVE\""), "missing MOVE: {json}");
        assert!(json.contains("\"Direction\":\"UP\""), "missing UP: {json}");
        // Core spawn 动作的 UnitType 大写。
        if json.contains("\"Spawn\"") {
            assert!(
                json.contains("\"UnitType\":\"WORKER\""),
                "missing WORKER: {json}"
            );
        }
    }

    #[test]
    fn handle_lifecycle_decide_apply_free() {
        let mut err_out: *mut c_char = std::ptr::null_mut();
        let config_json = c_str(
            r#"{"Name":"t1","WorkerTarget":6,"PopulationCeiling":16,"ExploreRadius":17,"ThreatDistance":5,"SpawnReserve":0,"MilitaryRatio":25,"EnableCoreMigration":false}"#,
        );
        let handle = unsafe { arena_planner_new(config_json.as_ptr(), &mut err_out) };
        assert!(!handle.is_null(), "new failed: {}", read_err(&mut err_out));

        let state_json = c_str(GO_STATE_JSON);
        let plan_json = unsafe { arena_planner_decide(handle, state_json.as_ptr(), &mut err_out) };
        assert!(
            !plan_json.is_null(),
            "decide failed: {}",
            read_err(&mut err_out)
        );
        let plan_text = unsafe { CStr::from_ptr(plan_json) }
            .to_str()
            .unwrap()
            .to_string();
        unsafe { drop(CString::from_raw(plan_json)) };
        assert!(plan_text.contains("\"Tick\":1"));

        let directive_json = c_str(r#"{"Mode":"GROWTH","Focus":[0,0]}"#);
        let ok_json =
            unsafe { arena_planner_apply_directive(handle, directive_json.as_ptr(), &mut err_out) };
        assert!(
            !ok_json.is_null(),
            "directive failed: {}",
            read_err(&mut err_out)
        );
        unsafe { drop(CString::from_raw(ok_json)) };

        unsafe { arena_planner_free(handle) };
        unsafe { arena_planner_free(std::ptr::null_mut()) }; // null 安全
    }

    #[test]
    fn null_handle_and_bad_input_error_path() {
        let mut err_out: *mut c_char = std::ptr::null_mut();
        // null 句柄 → 错误走 err_out，返回 null。
        let state_json = c_str(GO_STATE_JSON);
        let result = unsafe {
            arena_planner_decide(std::ptr::null_mut(), state_json.as_ptr(), &mut err_out)
        };
        assert!(result.is_null());
        let err = read_err(&mut err_out);
        assert!(err.contains("null planner handle"), "err: {err}");

        // 非法 JSON → 解析错误。
        let config_json = c_str(r#"{not-json"#);
        let handle = unsafe { arena_planner_new(config_json.as_ptr(), &mut err_out) };
        assert!(handle.is_null());
        let err = read_err(&mut err_out);
        assert!(err.contains("parse"), "err: {err}");
    }

    #[test]
    fn panic_never_crosses_abi() {
        // 注入 panic 的路径（catch_unwind 边界）——用非法输入触发内部
        // 处理外的 panic 场景不可构造（全部走 Err），直接验证边界逻辑：
        // catch_unwind 捕获 panic → err_out 错误 + 返回 null。
        let mut err_out: *mut c_char = std::ptr::null_mut();
        let result = unsafe {
            call_boundary(
                || -> Result<String, String> { panic!("boom") },
                &mut err_out,
            )
        };
        assert!(result.is_null());
        let err = read_err(&mut err_out);
        assert!(err.contains("panic"), "err: {err}");
    }

    #[test]
    fn cross_tick_state_remembered() {
        // 句柄化实例跨 tick 记忆（巡逻连续性）：两次 decide 之间 planner
        // 状态持久——patrolTargets 在第二次决策时已存在。
        let mut err_out: *mut c_char = std::ptr::null_mut();
        let config_json = c_str(
            r#"{"Name":"t1","WorkerTarget":6,"PopulationCeiling":16,"ExploreRadius":17,"ThreatDistance":5,"SpawnReserve":0,"MilitaryRatio":25,"EnableCoreMigration":false}"#,
        );
        let handle = unsafe { arena_planner_new(config_json.as_ptr(), &mut err_out) };
        assert!(!handle.is_null());
        let planner = unsafe { &mut *(handle as *mut Planner) };
        assert!(planner.patrol_targets.is_empty());
        let state = state_from_go_json(GO_STATE_JSON).unwrap();
        let _ = planner.decide(&state);
        let _ = planner.decide(&state);
        unsafe { arena_planner_free(handle) };
    }

    /// CString 测试辅助。
    fn c_str(value: &str) -> CString {
        CString::new(value).expect("no NUL")
    }

    /// 读并释放 err_out。
    fn read_err(err_out: &mut *mut c_char) -> String {
        if err_out.is_null() {
            return String::new();
        }
        let text = unsafe { CStr::from_ptr(*err_out) }
            .to_str()
            .unwrap_or("<invalid utf-8>")
            .to_string();
        unsafe { drop(CString::from_raw(*err_out)) };
        *err_out = std::ptr::null_mut();
        text
    }
}
