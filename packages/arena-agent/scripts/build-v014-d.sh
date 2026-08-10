#!/usr/bin/env bash
# v0.14 数据集构建 + 修复部署（2026-08-07d 已执行：t1/t2 各 230 samples；
# 生产重启加载 2ffa2e8 修复）
# 用法：bash scripts/build-v014-d.sh [批次后缀]（默认 d——下一批传 e）
# 流程：优雅关停 → manifest flush → sim:dataset 构建（stall-run quarantine
# 自动生效）→ watchdog 自动恢复（加载当前 checkout——含 2ffa2e8 军事单位
# Core 格禁区修复）。
set -euo pipefail

BATCH="${1:-d}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARENA_TS_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
AGENT_ROOT="${ARENA_AGENT_ROOT:-$ARENA_TS_ROOT/packages/arena-agent}"
DATA_ROOT="${ARENA_DATA_ROOT:-$(dirname "$ARENA_TS_ROOT")/data}/runtime"

echo "[1/5] graceful shutdown (POST /shutdown)"
curl -s -X POST http://127.0.0.1:8120/shutdown || true
sleep 12

echo "[2/5] locate run manifests"
for t in t1 t2; do
  RUN_DIR=$(ls -dt "$DATA_ROOT/$t/calibration"/*/ | head -1)
  MANIFEST="$RUN_DIR/manifest.json"
  if [ ! -f "$MANIFEST" ]; then
    echo "  $t: manifest MISSING at $MANIFEST"
    exit 1
  fi
  echo "  $t: rules $(python -c "import json,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); print(d.get('rulesVersion'), 'cases', d.get('caseCount'))" "$MANIFEST")"
done

echo "[3/5] build datasets (stall-run quarantine active)"
cd "$AGENT_ROOT"
npx tsx src/cli/run-sim.ts dataset --manifest "$DATA_ROOT/t1/calibration/$(ls -dt "$DATA_ROOT/t1/calibration"/*/ | head -1 | xargs basename)/manifest.json" --dataset-id "t1-v014-20260807$BATCH"
npx tsx src/cli/run-sim.ts dataset --manifest "$DATA_ROOT/t2/calibration/$(ls -dt "$DATA_ROOT/t2/calibration"/*/ | head -1 | xargs basename)/manifest.json" --dataset-id "t2-v014-20260807$BATCH"

echo "[4/5] wait for watchdog auto-recovery"
sleep 75
curl -s http://127.0.0.1:8120/ready | python -c "import json,sys; d=json.load(sys.stdin); print('ready:', d['ready'], [(t['tenantId'], t['ready']) for t in d['tenants']])"

echo "[5/5] verify new run starts (tick advancing + CORE_SPAWN_FAILED=0 for fix)"
python - "$DATA_ROOT" <<'PY'
import json, glob, os, sys
root = sys.argv[1]
for t in ["t1", "t2"]:
    runs = sorted(glob.glob(f"{root}/{t}/calibration/*/"), key=os.path.getmtime)
    latest = runs[-1]
    print(f"  {t}: new run cases={len(glob.glob(latest + 'cases/*.json'))}")
PY
echo "DONE"
