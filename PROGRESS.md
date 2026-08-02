# PROGRESS — 切片 A: raw-state 多租户污染修复

- 目标: runs/<run_id>/raw-state/<tenant_id>/<tick>.json + 原子写（tmp + os.replace）
- 顺序: ① 前提核验(135 passed ✓) ② main.py 抽 write_raw_state（原子+按 tenant.name 分目录）③ config/run.py 注释契约 ④ tests/test_raw_state.py ⑤ 全量 pytest + commit + push
- 最大风险: 双处分目录（run.py 传子目录 + main.py 再分）会变 raw-state/t1/t1/——隔离逻辑只放 main.py 一处，run.py 只传 base
