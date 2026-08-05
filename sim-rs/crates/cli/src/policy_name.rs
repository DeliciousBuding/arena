//! 策略可读名（与 Go `sim.PolicyName` 一致）：优先 Name 字段，
//! 否则确定性字段拼接 `wt%d_r%d_er%d_pc%d_m%d`。

use arena_sim_strategy::Config;

/// 返回策略可读名。
pub fn policy_name(policy: &Config) -> String {
    if !policy.name.is_empty() {
        return policy.name.clone();
    }
    format!(
        "wt{}_r{}_er{}_pc{}_m{}",
        policy.worker_target,
        policy.spawn_reserve,
        policy.explore_radius,
        policy.population_ceiling,
        policy.military_ratio
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_field_wins() {
        let mut config = Config::default();
        config.name = "aggressive".to_string();
        assert_eq!(policy_name(&config), "aggressive");
    }

    #[test]
    fn deterministic_field_concat() {
        let config = Config {
            worker_target: 8,
            spawn_reserve: 5,
            explore_radius: 16,
            population_ceiling: 20,
            military_ratio: 25,
            ..Config::default()
        };
        assert_eq!(policy_name(&config), "wt8_r5_er16_pc20_m25");
    }
}
