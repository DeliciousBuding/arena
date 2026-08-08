# Arena TS Offline Learning — Python 消费示例

最后更新：2026-08-08

本目录包含从 Python 消费 Arena TS 离线学习数据的最小示例。
**零重依赖**：仅需 `json`（stdlib）+ 可选 `pyarrow`/`numpy` 用于高效加载。

## 数据格式

TS 侧导出两种互补格式：

| 格式 | 文件 | 粒度 | 用途 |
|------|------|------|------|
| `trajectory-v1` | `trajectories.jsonl` | 完整 episode | Decision Transformer, MAPPO, QMIX |
| `feature-vector-v1` | `features.jsonl` | 单 tick | BC, DAgger, 特征工程 |

## 安装（可选加速）

```bash
pip install numpy pyarrow  # 可选：高效列式加载
```

stdlib-only 模式也可用（仅 json）。

## 1. 加载轨迹数据

```python
import json

def load_trajectories(path: str) -> list[dict]:
    """加载 trajectory-v1 JSONL 文件。每行一个完整 episode。"""
    trajectories = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                trajectories.append(json.loads(line))
    return trajectories

# 使用
trajs = load_trajectories("trajectories.jsonl")
print(f"Loaded {len(trajs)} trajectories")
print(f"First trajectory: {trajs[0]['metadata']['tickCount']} ticks")
print(f"Schema: {trajs[0]['schema']}")  # "trajectory-v1"
```

## 2. 提取 BC 训练数据

```python
def extract_bc_dataset(trajectories: list[dict]) -> tuple[list, list]:
    """从轨迹提取 Behavior Cloning 训练对 (state_features, action_labels)。"""
    X, y = [], []
    for traj in trajectories:
        for step in traj["steps"]:
            state = step["state"]
            action = step["action"]
            # 特征向量（31 维）
            features = [
                state["resources"], state["population"],
                state["workers"], state["vanguards"], state["rangers"],
                state["coreHp"], state["coreShield"],
                state["visibleEnemyUnits"], state["visibleEnemyCombat"],
                # ... 完整 31 维见 FEATURE_NAMES
            ]
            # 动作标签（简化：move/harvest/deposit 占比）
            counts = action["actionCounts"]
            total = sum(counts.values()) or 1
            label = [
                counts.get("MOVE", 0) / total,
                counts.get("HARVEST", 0) / total,
                counts.get("DEPOSIT", 0) / total,
                counts.get("WAIT", 0) / total,
            ]
            X.append(features)
            y.append(label)
    return X, y

# 可选：numpy 加速
# import numpy as np
# X_np = np.array(X, dtype=np.float32)
# y_np = np.array(y, dtype=np.float32)
```

## 3. 加载特征向量（31 维标准格式）

```python
def load_features(path: str) -> dict:
    """加载 feature-vector-v1 JSONL，按 episode 分组。"""
    by_episode = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            ep_id = row["episodeId"]
            if ep_id not in by_episode:
                by_episode[ep_id] = []
            by_episode[ep_id].append(row)
    return by_episode

features = load_features("features.jsonl")
for ep_id, ticks in features.items():
    print(f"Episode {ep_id}: {len(ticks)} ticks")
    print(f"  Feature keys: {list(ticks[0]['features'].keys())[:5]}...")
    break
```

## 4. Arrow/Parquet 导出（可选，高效列式）

```python
# 需要: pip install pyarrow pandas
import pyarrow as pa
import pandas as pd

def features_to_parquet(jsonl_path: str, parquet_path: str):
    """将 feature-vector-v1 JSONL 转为 Parquet 列式存储。"""
    rows = []
    with open(jsonl_path, "r") as f:
        for line in f:
            line = line.strip()
            if line:
                row = json.loads(line)
                flat = {
                    "episodeId": row["episodeId"],
                    "tenantId": row["tenantId"],
                    "tick": row["tick"],
                    "label_immediateResourceDelta": row["label"]["immediateResourceDelta"],
                    "label_netResourceDelta20": row["label"]["netResourceDelta20"],
                    "label_deathProb20": row["label"]["deathProb20"],
                    "label_coreRisk50": row["label"]["coreRisk50"],
                    "label_windowComplete": row["label"]["windowComplete"],
                }
                # 展开 31 维特征
                for k, v in row["features"].items():
                    flat[f"feat_{k}"] = v
                rows.append(flat)

    df = pd.DataFrame(rows)
    table = pa.Table.from_pandas(df)
    # 写入 Parquet（Snappy 压缩）
    import pyarrow.parquet as pq
    pq.write_table(table, parquet_path, compression="snappy")
    print(f"Wrote {len(rows)} rows to {parquet_path}")
    print(f"Columns: {table.num_columns}, Size: {table.nbytes / 1024 / 1024:.1f} MB")
```

## 5. 消费 benchmark-result-v1

```python
def load_benchmark(path: str) -> dict:
    """加载策略评估基准结果。"""
    with open(path, "r") as f:
        return json.loads(f.read().strip().split("\n")[0])  # JSONL: 取首行

result = load_benchmark("benchmark-result.jsonl")
print(f"Policy: {result['policyId']}")
print(f"Episodes: {len(result['episodes'])}")
print(f"Aggregate survival: {result['aggregate']['survivalTicks']:.0f} ticks")
print(f"Aggregate efficiency: {result['aggregate']['efficiencyRatio']:.2f} res/tick")
```

## ML 路线建议

从离线数据训练的顺序（按数据依赖递增）：

| 优先级 | 方法 | 数据需求 | 说明 |
|--------|------|----------|------|
| **P0** | BC (Behavior Cloning) | feature-vector-v1, 单 tick | 最简：用 `(state, action)` 对监督学习模仿现有 planner |
| **P1** | DAgger | trajectory-v1, 在线交互 | BC 基础上用在线交互修正分布偏移 |
| **P2** | Decision Transformer | trajectory-v1, 完整 episode | 序列建模 `(R, s, a)` 三元组，GPT 架构 |
| **P3** | MAPPO/QMIX | trajectory-v1, 多智能体 | 多租户协同/对抗，需要 opponent 轨迹 |

**当前阶段建议**：先跑 BC baseline，验证数据管道完整性，再逐步升级。

## 确定性保证

所有数据输出满足：
- `trajectoryId` = SHA-256（canonical JSON），相同 episode 重建 → 相同 ID
- 特征向量为纯函数（无 RNG、无 I/O），相同 state → 相同 Float64Array
- Split 分配为纯函数（chronological sort），相同输入 → 相同 split
- 这些保证使 ML 实验可复现：记录 `trajectoryId` + `seed` 即可精确复现
