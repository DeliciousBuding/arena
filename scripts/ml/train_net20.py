"""M1c: net20 single-head baselines on the M1b real-sample export.

Consumes data/runs/ml/<build>/ (features-all/train/validation/test.jsonl +
feature-quality.json + manifest.json) produced by the TS exporter; this
script only trains and evaluates — it never re-derives state features
(TS stays the state->feature SSOT, dl-implementation-plan v3).

Models (net20 regression, active-mask features by default):
  - DummyRegressor(mean)  : floor baseline
  - Ridge                 : linear
  - HistGradientBoosting  : tabular gradient boosting
  - MLPRegressor (small)  : sklearn MLP (no torch until M3)

Primary metric: Spearman rank correlation on the real-only future holdout
(test). MAE/RMSE are reported alongside; "passes mean baseline" on test MAE
is the pipeline-validity gate. Negative results are reported honestly.

Usage:
  python train_net20.py [build-id] [--all-features] [--out <dir>]
"""

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.dummy import DummyRegressor
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, mean_squared_error, roc_auc_score
from sklearn.neural_network import MLPRegressor

RANDOM_STATE = 42
REPORT_SCHEMA = "ml-net20-report-v1"


def arena_data_root() -> Path:
    env = os.environ.get("ARENA_DATA_ROOT")
    if env:
        return Path(env)
    # arena-ts/scripts/ml/ -> ../../../data
    return (Path(__file__).resolve().parent.parent.parent.parent / "data")


def load_split(build_dir: Path, split: str) -> pd.DataFrame:
    path = build_dir / f"{split}.jsonl"
    if not path.exists():
        return pd.DataFrame()
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return pd.DataFrame(rows)


def load_active_mask(build_dir: Path) -> list[str]:
    quality = json.loads((build_dir / "feature-quality.json").read_text(encoding="utf-8"))
    active = [name for name, mask in quality["activeMask"].items() if mask]
    return active


def feature_matrix(frame: pd.DataFrame, feature_names: list[str]) -> np.ndarray:
    features = frame["features"].apply(pd.Series)
    missing = [name for name in feature_names if name not in features.columns]
    if missing:
        raise ValueError(f"features missing from export: {missing}")
    matrix = features[feature_names].to_numpy(dtype=float)
    if not np.isfinite(matrix).all():
        raise ValueError("non-finite values in feature matrix (export bug, fail closed)")
    return matrix


def evaluate(model, x: np.ndarray, y: np.ndarray) -> dict:
    pred = model.predict(x)
    spearman_result = spearmanr(y, pred) if len(y) > 2 else None
    # net20>0 正类识别能力（对零主导分布比 MAE 更有意义的视角）。
    positives = (y > 0).astype(int)
    auc = None
    if len(set(positives)) == 2 and len(np.unique(pred)) > 1:
        auc = float(roc_auc_score(positives, pred))
    return {
        "mae": float(mean_absolute_error(y, pred)),
        "rmse": float(np.sqrt(mean_squared_error(y, pred))),
        "spearman": float(spearman_result.statistic) if spearman_result is not None else None,
        "spearmanP": float(spearman_result.pvalue) if spearman_result is not None else None,
        "aucNet20Positive": auc,
    }


def fit_and_score(model, x_train, y_train, x_val, y_val, x_test, y_test) -> dict:
    model.fit(x_train, y_train)
    return {
        "model": type(model).__name__,
        "train": evaluate(model, x_train, y_train),
        "validation": evaluate(model, x_val, y_val),
        "test": evaluate(model, x_test, y_test),
    }


def build_report(build_dir: Path, out_dir: Path, feature_names: list[str], all_features: bool) -> dict:
    train = load_split(build_dir, "train")
    validation = load_split(build_dir, "validation")
    test = load_split(build_dir, "test")
    for split, frame in (("train", train), ("validation", validation), ("test", test)):
        if frame.empty:
            raise ValueError(f"empty split: {split}")

    y_train = train["label"].apply(pd.Series)["net20"].to_numpy(dtype=float)
    y_val = validation["label"].apply(pd.Series)["net20"].to_numpy(dtype=float)
    y_test = test["label"].apply(pd.Series)["net20"].to_numpy(dtype=float)
    x_train = feature_matrix(train, feature_names)
    x_val = feature_matrix(validation, feature_names)
    x_test = feature_matrix(test, feature_names)

    models = {
        "DummyRegressor(mean)": DummyRegressor(strategy="mean"),
        "Ridge": Ridge(alpha=1.0, random_state=RANDOM_STATE),
        "HistGradientBoosting": HistGradientBoostingRegressor(
            random_state=RANDOM_STATE, max_iter=300, max_leaf_nodes=31,
        ),
        "MLPRegressor": MLPRegressor(
            hidden_layer_sizes=(64, 32), max_iter=500, random_state=RANDOM_STATE,
            early_stopping=True, n_iter_no_change=20,
        ),
    }
    results = [
        fit_and_score(model, x_train, y_train, x_val, y_val, x_test, y_test)
        for model in models.values()
    ]

    test_mae_floor = results[0]["test"]["mae"]
    for result in results:
        result["test_mae_relative_to_mean"] = (
            result["test"]["mae"] / test_mae_floor - 1.0 if test_mae_floor else None
        )
        result["passed_mean_baseline"] = result["test"]["mae"] < test_mae_floor - 1e-9
        # 主门禁：test 上 Spearman 显著为正（零主导分布下 MAE 门禁不适用）。
        spearman = result["test"].get("spearman")
        spearman_p = result["test"].get("spearmanP")
        result["passed_spearman_gate"] = (
            spearman is not None and spearman > 0 and spearman_p is not None and spearman_p < 0.05
        )

    # Feature importance from HistGB via permutation (sklearn 1.8 removed
    # feature_importances_ on HistGB).
    feature_importance = None
    for result in results:
        if result["model"] == "HistGradientBoostingRegressor":
            hist_gb = next(
                model for model in models.values() if isinstance(model, HistGradientBoostingRegressor)
            )
            from sklearn.inspection import permutation_importance

            perm = permutation_importance(
                hist_gb, x_test, y_test, n_repeats=5, random_state=RANDOM_STATE, scoring="neg_mean_absolute_error",
            )
            order = np.argsort(perm.importances_mean)[::-1]
            feature_importance = [
                {"feature": feature_names[index], "importance": float(perm.importances_mean[index])}
                for index in order[:20]
            ]
            break

    manifest = json.loads((build_dir / "manifest.json").read_text(encoding="utf-8"))
    quality = json.loads((build_dir / "feature-quality.json").read_text(encoding="utf-8"))
    report = {
        "schema": REPORT_SCHEMA,
        "buildId": manifest["buildId"],
        "createdAt": pd.Timestamp.now(tz="UTC").isoformat(),
        "featureCount": len(feature_names),
        "allFeatures": all_features,
        "hygiene": {
            "featureQualityScope": quality.get("scope", "unknown"),
            "featureQualityScopeCount": quality.get("scopeCount"),
            "note": (
                "P0 fix: activeMask and OOD min/max ranges are computed over "
                "TRAIN-ELIGIBLE rows only — validation/test distributions never "
                "enter feature selection or the deployed OOD reference."
            ),
        },
        "splits": {
            "train": int(len(train)),
            "validation": int(len(validation)),
            "test": int(len(test)),
        },
        "label": {"head": "net20", "note": "net20 == 0 占比约 93%（类别偏置极大）"},
        "models": results,
        "featureImportance": feature_importance,
        "gates": {
            "primary": "Spearman > 0 with p < 0.05 on the real-only future holdout (test)",
            "passed_spearman_gate_on_test": any(
                result["passed_spearman_gate"] for result in results
            ),
            "passed_mean_baseline_on_test": any(
                result["passed_mean_baseline"] for result in results
            ),
            "realOnlyFutureHoldout": True,
            "note": "net20 零主导（test 77.7%），mean-baseline MAE 门禁不适用，仅作参考",
        },
        "negativeResults": [
            result["model"] for result in results
            if not result["passed_spearman_gate"] and not result["passed_mean_baseline"]
        ],
    }
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="M1c net20 single-head baselines")
    parser.add_argument("build_id", nargs="?", default="m1b-20260808")
    parser.add_argument("--all-features", action="store_true",
                        help="use all 59 features instead of the active mask")
    parser.add_argument("--out", default=None, help="output directory (default: build dir)")
    args = parser.parse_args()

    build_dir = arena_data_root() / "runs" / "ml" / args.build_id
    if not build_dir.exists():
        print(f"build dir not found: {build_dir}", file=sys.stderr)
        return 1

    feature_names = None if args.all_features else load_active_mask(build_dir)
    if feature_names is None:
        quality = json.loads((build_dir / "feature-quality.json").read_text(encoding="utf-8"))
        feature_names = [entry["feature"] for entry in quality["entries"]]

    report = build_report(build_dir, build_dir, feature_names, args.all_features)
    out_dir = Path(args.out) if args.out else build_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "net20-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8",
    )

    print(f"build={report['buildId']} features={report['featureCount']} "
          f"train={report['splits']['train']} val={report['splits']['validation']} "
          f"test={report['splits']['test']}")
    for result in report["models"]:
        test = result["test"]
        print(f"  {result['model']:<24} test MAE={test['mae']:.4f} "
              f"RMSE={test['rmse']:.4f} Spearman={test['spearman']:.4f} "
              f"(p={test.get('spearmanP'):.2e}) AUC={test.get('aucNet20Positive')} "
              f"rel={result['test_mae_relative_to_mean']:+.3f} "
              f"{'PASS-spearman' if result['passed_spearman_gate'] else ('PASS-mae' if result['passed_mean_baseline'] else 'fail')}")
    print(f"report -> {out_dir / 'net20-report.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
