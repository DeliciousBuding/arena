"""config.py 单测：参数集中、动态 reserve、运行时调整、秘钥加载。"""

from arena_bot.config import TacticConfig, load_api_key, WORKER_COST


def test_spawn_reserve_early_and_wealthy():
    cfg = TacticConfig()
    assert cfg.spawn_reserve(5) == 1   # 早期：只留 1
    assert cfg.spawn_reserve(9) == 1
    assert cfg.spawn_reserve(10) == 3  # 富足：留 3
    assert cfg.spawn_reserve(20) == 3


def test_with_param_returns_new_instance():
    cfg = TacticConfig()
    new = cfg.with_param("explore_radius", 12)
    assert new.explore_radius == 12
    assert cfg.explore_radius == 8  # 原实例不变（frozen）
    assert new is not cfg


def test_with_param_unknown_raises():
    cfg = TacticConfig()
    try:
        cfg.with_param("no_such_param", 1)
        raise AssertionError("应当抛 KeyError")
    except KeyError:
        pass


def test_work_cost_constant():
    assert WORKER_COST == 5  # 规则 v0.10：Worker 5 资源


def test_api_key_loadable_without_credential_output():
    # 不校验秘钥值本身（可能为空），只验证读取函数可用且不抛
    key = load_api_key()
    assert isinstance(key, str)
