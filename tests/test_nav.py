"""core/nav.py 工具函数测试（原 test_tactic.py 工具用例迁移）。"""

from arena_hero import Direction

from arena_bot.core.nav import (explore_target, line_blocked, manhattan,
                                nearest, step_toward)


def test_manhattan():
    assert manhattan((0, 0), (3, 4)) == 7
    assert manhattan((5, 5), (5, 5)) == 0


def test_line_blocked_diagonal_intermediate_only():
    # 对角中间格被堵 → 挡；旁边格被堵 → 不挡
    assert line_blocked((0, 0), (3, 3), {(1, 1)}) is True
    assert line_blocked((0, 0), (3, 3), {(1, 2)}) is False
    assert line_blocked((0, 0), (2, 2), {(1, 2)}) is False


def test_line_blocked_axis():
    assert line_blocked((0, 0), (0, 3), {(0, 1)}) is True
    assert line_blocked((0, 0), (0, 3), {(1, 1)}) is False  # 旁边不挡
    assert line_blocked((0, 0), (0, 1), {(0, 0)}) is False  # 目标格不挡


def test_step_toward_prefers_major_axis():
    d = step_toward((0, 0), (0, 5), set())
    assert d is Direction.DOWN
    d = step_toward((0, 0), (5, 0), set())
    assert d is Direction.RIGHT


def test_step_toward_boxed_returns_none():
    assert step_toward((1, 0), (0, 0), {(0, 0), (2, 0), (1, 1), (1, -1)}) is None


def test_explore_target_radius_and_rotation():
    # Beacon 在正东 → base RIGHT；index 1 顺时针 → DOWN
    t0 = explore_target((0, 0), (0, 0), (10, 0), 0, 8)
    assert t0 == (8, 0)
    t1 = explore_target((0, 0), (0, 0), (10, 0), 1, 8)
    assert t1 == (0, 8)
    # Beacon 在正北 → base UP；index 0 → UP
    t2 = explore_target((0, 0), (0, 0), (0, -10), 0, 8)
    assert t2 == (0, -8)


def test_nearest_deterministic_tiebreak():
    # 同距离时 x 小优先（key=(dist, x, y)）
    assert nearest([(2, 0), (0, 2), (10, 10)], (0, 0)) == (0, 2)
    assert nearest([(5, 5)], (0, 0)) == (5, 5)
