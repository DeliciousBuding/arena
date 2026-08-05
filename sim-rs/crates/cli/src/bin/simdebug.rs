//! simdebug：临时诊断工具（与 Go `cmd/simdebug/main.go` 对偶）——单场景跑
//! N tick，定期 dump 每个单位的位置/货仓/HP + 意图，定位经济冻结（工人
//! 不去采/回仓被堵等）。
//!
//! 用法：
//! ```bash
//! simdebug --scene runtime/scenes/base.json --policy default --ticks 100 --dump 25
//! ```

use std::fs;
use std::process::ExitCode;

use arena_sim_cli::SceneFile;
use arena_sim_domain::{move_position, Plan, TickState, UnitActionKind};
use arena_sim_engine::{Engine, RefillConfig};
use arena_sim_strategy::{Config, Planner};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut scene_path = "runtime/scenes/base.json".to_string();
    let mut policy_name = "default".to_string();
    let mut ticks = 100;
    let mut dump_every = 25;

    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        let (name, inline) = match arg.strip_prefix("--").or_else(|| arg.strip_prefix('-')) {
            Some(rest) if !rest.is_empty() => match rest.split_once('=') {
                Some((name, value)) => (name, Some(value.to_string())),
                None => (rest, None),
            },
            // Go flag 在第一个位置参数处停止解析。
            _ => break,
        };
        match name {
            "scene" => match flag_string_value(name, inline, &args, &mut i) {
                Ok(v) => scene_path = v,
                Err(msg) => return flag_error(&msg),
            },
            "policy" => match flag_string_value(name, inline, &args, &mut i) {
                Ok(v) => policy_name = v,
                Err(msg) => return flag_error(&msg),
            },
            "ticks" => match flag_int_value(name, inline, &args, &mut i) {
                Ok(v) => ticks = v,
                Err(msg) => return flag_error(&msg),
            },
            "dump" => match flag_int_value(name, inline, &args, &mut i) {
                Ok(v) => dump_every = v,
                Err(msg) => return flag_error(&msg),
            },
            _ => {
                eprintln!("flag provided but not defined: -{name}");
                eprintln!(
                    "usage: simdebug [--scene <scene.json>] [--policy <name>] [--ticks N] [--dump N]"
                );
                return ExitCode::from(2);
            }
        }
        i += 1;
    }

    let data = match fs::read_to_string(&scene_path) {
        Ok(data) => data,
        Err(err) => {
            eprintln!("read scene: {err}");
            return ExitCode::FAILURE;
        }
    };
    let file: SceneFile = match serde_json::from_str(&data) {
        Ok(file) => file,
        Err(err) => {
            eprintln!("parse scene: {err}");
            return ExitCode::FAILURE;
        }
    };
    let Some(initial) = file.initial.as_ref() else {
        eprintln!("parse scene: initial state missing");
        return ExitCode::FAILURE;
    };
    let mut state = initial.to_tick_state();
    let config = Config {
        name: policy_name,
        ..Config::default()
    };
    let mut planner = Planner::new(config);
    let mut engine = Engine::new();
    engine.refill = Some(RefillConfig::new(&file.latent_resources));

    for tick in 1..=ticks {
        state.tick = tick;
        let plan = planner.decide(&state);
        let settled = engine.settle(&state, &plan);
        if tick % dump_every == 0 || tick == ticks {
            print!(
                "{}",
                dump_block(tick, &settled.next_state, settled.stats.blocked, &plan)
            );
        }
        state = settled.next_state;
    }
    ExitCode::SUCCESS
}

/// 生成 dump 块文本（与 Go simdebug 输出逐字节一致）：块头 + 每单位一行。
fn dump_block(tick: i32, next: &TickState, blocked: i32, plan: &Plan) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "\n=== t{} res={} space={} cells={} workers={} blocked={} ===\n",
        tick,
        next.resources,
        next.resource_space,
        next.resource_cells.len(),
        next.workers.len(),
        blocked
    ));
    for unit in &next.units {
        let intent = plan
            .intents
            .get(&unit.id)
            .map(|s| s.as_str())
            .unwrap_or("-");
        let action = plan.unit_actions.get(&unit.id);
        let action_kind = action.map(|a| action_kind_str(a.kind)).unwrap_or("-");
        let detail = match action.and_then(|a| a.direction) {
            Some(direction) => {
                let target = move_position(unit.position, direction);
                format!("→({},{})", target[0], target[1])
            }
            None => String::new(),
        };
        out.push_str(&format!(
            "  {:<12} {:<8} at({},{}) cargo={} hp={} intent={:<16} action={}{}\n",
            unit.id,
            unit.unit_type.as_str(),
            unit.position[0],
            unit.position[1],
            unit.cargo,
            unit.hp,
            intent,
            action_kind,
            detail
        ));
    }
    out
}

/// 动作类型可读名（与 Go `string(action.Kind)` 一致）。
fn action_kind_str(kind: UnitActionKind) -> &'static str {
    match kind {
        UnitActionKind::Wait => "WAIT",
        UnitActionKind::Move => "MOVE",
        UnitActionKind::Harvest => "HARVEST",
        UnitActionKind::Deposit => "DEPOSIT",
        UnitActionKind::Sweep => "SWEEP",
        UnitActionKind::Shoot => "SHOOT",
        UnitActionKind::PickupBeacon => "PICKUP_BEACON",
        UnitActionKind::DropBeacon => "DROP_BEACON",
        UnitActionKind::SelfDestruct => "SELF_DESTRUCT",
        UnitActionKind::Heal => "HEAL",
    }
}

/// 取 `-name value` 或 `-name=value` 的字符串值（Go flag 语义）。
fn flag_string_value(
    name: &str,
    inline: Option<String>,
    args: &[String],
    pos: &mut usize,
) -> Result<String, String> {
    match inline {
        Some(value) => Ok(value),
        None => {
            *pos += 1;
            args.get(*pos)
                .cloned()
                .ok_or_else(|| format!("flag needs an argument: -{name}"))
        }
    }
}

/// 取 `-name value` 或 `-name=value` 的整数值（Go flag 语义）。
fn flag_int_value(
    name: &str,
    inline: Option<String>,
    args: &[String],
    pos: &mut usize,
) -> Result<i32, String> {
    let value = flag_string_value(name, inline, args, pos)?;
    value
        .parse::<i32>()
        .map_err(|_| format!("invalid value \"{value}\" for flag -{name}: parse error"))
}

fn flag_error(msg: &str) -> ExitCode {
    eprintln!("{msg}");
    eprintln!("usage: simdebug [--scene <scene.json>] [--policy <name>] [--ticks N] [--dump N]");
    ExitCode::from(2)
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::BTreeMap;

    use arena_sim_domain::{
        Beacon, BeaconStatus, CoreStatus, Direction, TickState, UnitAction, UnitActionKind,
        UnitSnapshot, UnitType,
    };

    /// 构造最小 TickState（测试辅助）。
    fn test_state(units: Vec<UnitSnapshot>) -> TickState {
        TickState {
            tick: 1,
            status: CoreStatus::Active,
            resources: 0,
            resource_capacity: 10,
            resource_space: 10,
            population: 0,
            population_tier: 0,
            upkeep_next_tick: 0,
            core: None,
            units,
            workers: Vec::new(),
            vanguards: Vec::new(),
            rangers: Vec::new(),
            visible_enemies: Vec::new(),
            resource_cells: Default::default(),
            obstacle_cells: Default::default(),
            beacon: Beacon {
                position: [0, 0],
                status: BeaconStatus::Ground,
                carrier_id: None,
            },
            events: Vec::new(),
            state_hash: String::new(),
        }
    }

    #[test]
    fn action_kind_strings() {
        assert_eq!(action_kind_str(UnitActionKind::Wait), "WAIT");
        assert_eq!(action_kind_str(UnitActionKind::Move), "MOVE");
        assert_eq!(action_kind_str(UnitActionKind::Harvest), "HARVEST");
        assert_eq!(action_kind_str(UnitActionKind::Deposit), "DEPOSIT");
        assert_eq!(action_kind_str(UnitActionKind::Sweep), "SWEEP");
        assert_eq!(action_kind_str(UnitActionKind::Shoot), "SHOOT");
        assert_eq!(
            action_kind_str(UnitActionKind::PickupBeacon),
            "PICKUP_BEACON"
        );
        assert_eq!(action_kind_str(UnitActionKind::DropBeacon), "DROP_BEACON");
        assert_eq!(
            action_kind_str(UnitActionKind::SelfDestruct),
            "SELF_DESTRUCT"
        );
        assert_eq!(action_kind_str(UnitActionKind::Heal), "HEAL");
    }

    #[test]
    fn dump_block_full_line() {
        let mut state = test_state(vec![
            UnitSnapshot {
                id: "w-001".to_string(),
                position: [38, 39],
                hp: 2,
                unit_type: UnitType::Worker,
                cargo: 4,
            },
            UnitSnapshot {
                id: "v-007".to_string(),
                position: [10, 20],
                hp: 4,
                unit_type: UnitType::Vanguard,
                cargo: 0,
            },
        ]);
        state.resources = 12;
        state.resource_space = 3;
        state.resource_cells = vec!["38,45".to_string(), "30,34".to_string()]
            .into_iter()
            .collect();
        let mut plan = Plan {
            tick: 25,
            unit_actions: BTreeMap::new(),
            core_action: None,
            intents: BTreeMap::new(),
        };
        plan.unit_actions.insert(
            "w-001".to_string(),
            UnitAction {
                kind: UnitActionKind::Move,
                direction: Some(Direction::Down),
                target_id: None,
                expected_cell: None,
            },
        );
        plan.unit_actions.insert(
            "v-007".to_string(),
            UnitAction {
                kind: UnitActionKind::Sweep,
                direction: None,
                target_id: None,
                expected_cell: None,
            },
        );
        plan.intents
            .insert("w-001".to_string(), "harvest".to_string());
        plan.intents
            .insert("v-007".to_string(), "defend".to_string());

        let text = dump_block(25, &state, 3, &plan);
        assert_eq!(
            text,
            concat!(
                "\n=== t25 res=12 space=3 cells=2 workers=0 blocked=3 ===\n",
                "  w-001        WORKER   at(38,39) cargo=4 hp=2 intent=harvest          action=MOVE→(38,40)\n",
                "  v-007        VANGUARD at(10,20) cargo=0 hp=4 intent=defend           action=SWEEP\n",
            )
        );
    }

    #[test]
    fn dump_block_missing_intent_and_action() {
        let state = test_state(vec![UnitSnapshot {
            id: "r9".to_string(),
            position: [5, 5],
            hp: 2,
            unit_type: UnitType::Ranger,
            cargo: 1,
        }]);
        let plan = Plan {
            tick: 50,
            unit_actions: BTreeMap::new(),
            core_action: None,
            intents: BTreeMap::new(),
        };
        let text = dump_block(50, &state, 0, &plan);
        assert_eq!(
            text,
            concat!(
                "\n=== t50 res=0 space=10 cells=0 workers=0 blocked=0 ===\n",
                "  r9           RANGER   at(5,5) cargo=1 hp=2 intent=-                action=-\n",
            )
        );
    }

    #[test]
    fn move_detail_is_target_cell() {
        // 目标格 = 单位位置 + 方向位移（Direction::Right → +x）。
        let state = test_state(vec![UnitSnapshot {
            id: "u1".to_string(),
            position: [7, 3],
            hp: 2,
            unit_type: UnitType::Worker,
            cargo: 0,
        }]);
        let mut plan = Plan {
            tick: 25,
            unit_actions: BTreeMap::new(),
            core_action: None,
            intents: BTreeMap::new(),
        };
        plan.unit_actions.insert(
            "u1".to_string(),
            UnitAction {
                kind: UnitActionKind::Move,
                direction: Some(Direction::Right),
                target_id: None,
                expected_cell: None,
            },
        );
        let text = dump_block(25, &state, 0, &plan);
        assert!(
            text.contains("action=MOVE→(8,3)"),
            "expected MOVE detail →(8,3), got: {text}"
        );
    }

    #[test]
    fn action_kind_enum_order_matches_go_constants() {
        // Go 常量：WAIT/MOVE/HARVEST/DEPOSIT/SWEEP/SHOOT/PICKUP_BEACON/
        // DROP_BEACON/SELF_DESTRUCT/HEAL——Rust 枚举序必须一致（serde 输出）。
        assert_eq!(
            vec![
                action_kind_str(UnitActionKind::Wait),
                action_kind_str(UnitActionKind::Move),
                action_kind_str(UnitActionKind::Harvest),
                action_kind_str(UnitActionKind::Deposit),
                action_kind_str(UnitActionKind::Sweep),
                action_kind_str(UnitActionKind::Shoot),
                action_kind_str(UnitActionKind::PickupBeacon),
                action_kind_str(UnitActionKind::DropBeacon),
                action_kind_str(UnitActionKind::SelfDestruct),
                action_kind_str(UnitActionKind::Heal),
            ],
            vec![
                "WAIT",
                "MOVE",
                "HARVEST",
                "DEPOSIT",
                "SWEEP",
                "SHOOT",
                "PICKUP_BEACON",
                "DROP_BEACON",
                "SELF_DESTRUCT",
                "HEAL",
            ]
        );
    }
}
