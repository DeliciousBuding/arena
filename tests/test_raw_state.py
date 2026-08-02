"""raw state 落盘测试：分租户目录 + 原子写（tmp_path，无需真网络）。

背景：多租户进程曾共享同一 raw_state_dir，同 tick 不同账号写同名文件，
并发拼接/截断产生坏 JSON（shadow replay 跳过 1/12）。修复 = 按租户分目录 + 原子 rename。
"""

import json
import os

import pytest

from arena_bot.main import write_raw_state


def test_raw_state_tenant_isolation(tmp_path):
    """同 tick 不同租户写入互不覆盖，落在各自子目录；旧扁平路径不产生文件。"""
    raw_dir = tmp_path / "raw-state"
    t1_path = write_raw_state(raw_dir, tick=7, payload='{"a":1,"who":"t1"}',
                              tenant_name="t1")
    t2_path = write_raw_state(raw_dir, tick=7, payload='{"a":2,"who":"t2"}',
                              tenant_name="t2")

    assert t1_path == raw_dir / "t1" / "7.json"
    assert t2_path == raw_dir / "t2" / "7.json"
    assert json.loads(t1_path.read_text(encoding="utf-8"))["who"] == "t1"
    assert json.loads(t2_path.read_text(encoding="utf-8"))["who"] == "t2"
    # 旧路径（raw-state/<tick>.json 扁平）不被写入
    assert not (raw_dir / "7.json").exists()
    # 无 .tmp 残留
    assert not (raw_dir / "t1" / "7.json.tmp").exists()
    assert not (raw_dir / "t2" / "7.json.tmp").exists()


def test_raw_state_atomic_write_no_partial_file(tmp_path, monkeypatch):
    """先写 .tmp 再 os.replace：替换失败时最终路径不存在，读取方看不到半截文件。"""
    raw_dir = tmp_path / "raw-state"

    def boom(tmp, dst):
        raise OSError("simulated replace failure")

    # 模拟 os.replace 抛错（如跨进程竞争/磁盘瞬时故障）
    monkeypatch.setattr("arena_bot.main.os.replace", boom)

    with pytest.raises(OSError):
        write_raw_state(raw_dir, tick=9, payload='{"tick":9}',
                        tenant_name="t1")

    # 最终路径不被写入——绝无半截 JSON 可被读取
    assert not (raw_dir / "t1" / "9.json").exists()


def test_raw_state_uses_tmp_then_replace(tmp_path, monkeypatch):
    """原子性实现细节：写 .tmp → os.replace 到最终名（而非直接写最终名）。"""
    raw_dir = tmp_path / "raw-state"
    calls: list[tuple[str, str]] = []

    real_replace = os.replace

    def spy_replace(tmp: os.PathLike, dst: os.PathLike) -> None:
        calls.append((str(tmp), str(dst)))
        return real_replace(tmp, dst)

    monkeypatch.setattr("arena_bot.main.os.replace", spy_replace)
    final = write_raw_state(raw_dir, tick=5, payload='{"tick":5}',
                            tenant_name="t2")

    assert final == raw_dir / "t2" / "5.json"
    assert calls == [(str(raw_dir / "t2" / "5.json.tmp"),
                      str(raw_dir / "t2" / "5.json"))]
    assert not (raw_dir / "t2" / "5.json.tmp").exists()


def test_raw_state_solo_mode_flat_compat(tmp_path):
    """单账号（tenant_name=None）保持旧行为：直接写 <dir>/<tick>.json。"""
    raw_dir = tmp_path / "raw-state"
    final = write_raw_state(raw_dir, tick=3, payload='{"tick":3}')

    assert final == raw_dir / "3.json"
    assert json.loads(final.read_text(encoding="utf-8")) == {"tick": 3}
    # 租户写入不影响旧扁平文件
    write_raw_state(raw_dir, tick=4, payload='{"tick":4}', tenant_name="t1")
    assert (raw_dir / "3.json").read_text(encoding="utf-8") == '{"tick":3}'
