#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""arena-bench 评测报告 → 科研风格图集（pandas / matplotlib / seaborn）。

读取 run-arena-report.mts 生成的 results.json（schema arena.bench.report.v1/v2），
在 results.json 同目录下输出 plots/ 图集：

  01_leaderboard.png   综合榜单：横向条形 + 场景间误差棒 + 数值标注（学术白底）
  02_rank_heatmap.png  场景 × 条目平均排名热图（seaborn heatmap · viridis）
  03_kill_chart.png    击杀能力：killRate 柱状 + 场均首杀 tick 折线（双轴）
  04_radar.png         五维画像雷达图（全部条目叠加 · 半透明填充）
  05_boxplots.png      关键指标分面箱线图（资源效率 / 人口峰值 / 存活率）
  06_summary_table.png 逐场景汇总表（PNG 表格图 + CSV + stdout 打印）
  07_overview.png      汇总图板（2×3 拼版，供发帖）

用法：
  python arena_bench_plots.py <results.json 路径> [--out <plots 目录>]

本脚本不 import arena 任何代码，纯数据 → 图。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.font_manager as fm
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns

# --------------------------------------------------------------------------
# 全局样式：学术白底（Nature/ICML 论文风）
# --------------------------------------------------------------------------

COLORS = {
    "bg": "#ffffff",        # 画布/坐标区底（纯白）
    "panel": "#ffffff",     # 坐标区内底
    "border": "#333333",    # 坐标轴边框（深灰细线）
    "grid": "#777777",      # 网格线（细虚线，alpha 0.25 叠加）
    "text": "#111111",      # 主文字
    "muted": "#666666",     # 次要文字
}

SERIF_FONTS = [
    "Times New Roman", "Liberation Serif", "Nimbus Roman", "DejaVu Serif",
]

CJK_FONTS = [
    "Microsoft YaHei", "SimHei", "Noto Sans CJK SC", "Source Han Sans SC",
    "PingFang SC", "WenQuanYi Micro Hei",
]

_CJK_OK = False


def tr(zh: str, en: str) -> str:
    """找到中文字体返回中文文案，否则退回英文（避免方框乱码）。"""
    return zh if _CJK_OK else en


def setup_style() -> str | None:
    """配置 rcParams（白底学术风）；返回选中的西文衬线字体名。"""
    global _CJK_OK
    installed = {font.name for font in fm.fontManager.ttflist}
    serif = next((name for name in SERIF_FONTS if name in installed), None)
    if serif is None:
        serif = "DejaVu Serif"
    cjk = next((name for name in CJK_FONTS if name in installed), None)
    _CJK_OK = cjk is not None
    # 字体回退链：Times New Roman 优先，中文缺字时落到微软雅黑（matplotlib ≥3.7 逐字形回退）
    family = [serif] + ([cjk] if cjk else []) + ["DejaVu Serif"]
    plt.rcParams["font.family"] = family
    plt.rcParams.update(
        {
            "figure.dpi": 200,
            "savefig.dpi": 200,
            "font.size": 9.5,
            "axes.unicode_minus": False,
            # 白底
            "figure.facecolor": COLORS["bg"],
            "axes.facecolor": COLORS["panel"],
            "savefig.facecolor": COLORS["bg"],
            "text.color": COLORS["text"],
            "axes.labelcolor": COLORS["text"],
            "axes.edgecolor": COLORS["border"],
            "axes.linewidth": 0.8,
            "axes.titlecolor": COLORS["text"],
            "xtick.color": COLORS["text"],
            "ytick.color": COLORS["text"],
            "xtick.labelsize": 8.5,
            "ytick.labelsize": 8.5,
            "axes.labelsize": 10,
            "axes.titlesize": 11,
            "axes.titleweight": "bold",
            # 细虚线网格
            "axes.grid": True,
            "grid.color": COLORS["grid"],
            "grid.alpha": 0.25,
            "grid.linewidth": 0.5,
            "grid.linestyle": "--",
            # 学术风：只保留左/下边框
            "axes.spines.top": False,
            "axes.spines.right": False,
            # 图例
            "legend.facecolor": COLORS["bg"],
            "legend.edgecolor": "#cccccc",
            "legend.labelcolor": COLORS["text"],
            "legend.fontsize": 8.5,
            "legend.framealpha": 0.9,
        }
    )
    return serif


# --------------------------------------------------------------------------
# 数据装载与派生
# --------------------------------------------------------------------------

def load_results(path: Path) -> dict:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


_PLAYER_SUFFIX = re.compile(r"-s\d+$")


def entry_base_id(player_id: str) -> str:
    """'farmer-s1' → 'farmer'（兼容 v1 直接以条目 id 命名）。"""
    return _PLAYER_SUFFIX.sub("", player_id)


def entry_order(results: dict) -> list[str]:
    """条目顺序：综合榜单降序；榜单缺失时按各场景 perEntry 出现序补齐。"""
    order: list[str] = []
    for row in results.get("leaderboard", []):
        eid = row.get("contestantId")
        if eid and eid not in order:
            order.append(eid)
    for scenario in results.get("scenarios", []):
        for eid in scenario.get("perEntry", {}):
            if eid not in order:
                order.append(eid)
    return order


def entry_palette(entries: list[str]) -> dict[str, tuple]:
    """每条目一色（tab20+Set1 去重拼接，学术风），跨图全局一致。"""
    base = list(sns.color_palette("tab20", 20)) + list(sns.color_palette("Set1", 9))
    deduped: list[tuple] = []
    seen: set[tuple[float, float, float]] = set()
    for color in base:
        key = tuple(round(channel, 3) for channel in color)
        if key not in seen:
            seen.add(key)
            deduped.append(color)
    palette = deduped * (len(entries) // len(deduped) + 1)
    return dict(zip(entries, palette[: len(entries)]))


def scenario_palette(scenarios: list[dict]) -> dict[str, tuple]:
    """场景配色：viridis 采样（与热图同源色系，区分于条目色）。"""
    names = [s["name"] for s in scenarios]
    cmap = plt.get_cmap("viridis")
    if len(names) == 1:
        return {names[0]: cmap(0.5)}
    return {name: cmap(i / (len(names) - 1)) for i, name in enumerate(names)}


def meta_text(results: dict) -> str:
    """图元信息小字：N=场次数、seed 范围、ticks 等。"""
    params = results.get("params", {})
    scenarios = results.get("scenarios", [])
    seeds = params.get("seeds") or []
    n_matches = sum(len(s.get("matches", [])) for s in scenarios)
    seed_str = ",".join(str(s) for s in seeds) if seeds else "?"
    ticks = params.get("ticks", "?")
    players = params.get("players", "?")
    rules = params.get("rulesVersion", "?")
    generated = (results.get("generatedAt") or "")[:10] or "?"
    line1 = tr(
        f"N={n_matches} 场 · 场景 {len(scenarios)} 个 · seeds[{seed_str}] · ticks={ticks} · 每场 {players} 玩家 · 规则 {rules}",
        f"N={n_matches} matches · {len(scenarios)} scenarios · seeds[{seed_str}] · ticks={ticks} · {players} players · rules {rules}",
    )
    line2 = tr(
        f"生成 {generated} · schema {results.get('schema', '?')}",
        f"generated {generated} · schema {results.get('schema', '?')}",
    )
    return f"{line1}\n{line2}"


def add_meta(fig: plt.Figure, results: dict) -> None:
    fig.text(
        0.99, 0.004, meta_text(results),
        ha="right", va="bottom", fontsize=6.5, color=COLORS["muted"],
    )


def scenario_composites(results: dict) -> dict[str, list[float]]:
    """每条目在各场景内的综合分（场景内 min-max 归一化，与榜单同公式），
    用于综合榜单误差棒（跨场景波动）。"""
    series: dict[str, list[float]] = {}
    for scenario in results.get("scenarios", []):
        per_entry = scenario.get("perEntry", {})
        if not per_entry:
            continue
        ids = list(per_entry.keys())

        def norm01(values: list[float]) -> np.ndarray:
            arr = np.asarray(values, dtype=float)
            lo, hi = np.nanmin(arr), np.nanmax(arr)
            if not np.isfinite(lo) or not np.isfinite(hi) or hi <= lo:
                return np.full_like(arr, 1.0)
            return (arr - lo) / (hi - lo)

        rank_score = 1.0 - norm01([per_entry[e]["avgRank"] for e in ids])
        kill_score = norm01([per_entry[e]["killRate"] for e in ids])
        survival_score = norm01([per_entry[e]["survivalMedian"] for e in ids])
        composite = 0.6 * rank_score + 0.2 * kill_score + 0.2 * survival_score
        for eid, value in zip(ids, composite):
            series.setdefault(eid, []).append(float(value))
    return series


# --------------------------------------------------------------------------
# 图 1：综合榜单（横向条形 + 误差棒 + 数值标注）
# --------------------------------------------------------------------------

def draw_leaderboard(ax: plt.Axes, results: dict, colors: dict[str, tuple],
                     annotate: bool = True) -> None:
    rows = results.get("leaderboard", [])
    if not rows:
        ax.text(0.5, 0.5, tr("无榜单数据", "no leaderboard data"),
                ha="center", va="center", transform=ax.transAxes)
        ax.axis("off")
        return
    ids = [r["contestantId"] for r in rows]
    values = np.array([r.get("composite", 0.0) for r in rows], dtype=float)
    per_scenario = scenario_composites(results)
    errors = np.array([
        float(np.std(per_scenario.get(eid, [values[i]]))) for i, eid in enumerate(ids)
    ])
    y_pos = np.arange(len(ids))[::-1]  # 榜首置顶
    ax.barh(y_pos, values, height=0.62, color=[colors.get(eid, "#7f8c8d") for eid in ids],
            edgecolor="#333333", linewidth=0.4, alpha=0.94)
    ax.errorbar(values, y_pos, xerr=errors, fmt="none", ecolor=COLORS["text"],
                elinewidth=0.8, capsize=3)
    ax.set_yticks(y_pos, ids)
    if annotate:
        for y, value in zip(y_pos, values):
            ax.annotate(f"{value:.3f}", xy=(value, y), xytext=(5, 0),
                        textcoords="offset points", va="center", fontsize=8,
                        color=COLORS["text"])
    ax.set_xlim(0, max(1.0, float(np.nanmax(values)) * 1.12))
    ax.set_xlabel(tr("综合分（avgRank 60% + killRate 20% + survivalMedian 20%）",
                     "composite (avgRank 60% + killRate 20% + survivalMedian 20%)"))
    detail = "   ".join(
        f"{r.get('contestantId', '?')}: 均排 {r.get('avgRank', float('nan')):.2f} · 击杀 {r.get('killRate', 0):.2f}/场 · "
        f"存活 {r.get('survivalMedian', 0) * 100:.0f}%"
        for r in rows
    )
    ax.set_title(tr("综合榜单", "Composite leaderboard"), loc="left", pad=10)
    ax.text(0.0, -0.16, detail, transform=ax.transAxes, fontsize=6.5,
            color=COLORS["muted"], wrap=True)


def figure_leaderboard(results: dict, out_dir: Path) -> None:
    fig, ax = plt.subplots(figsize=(9, 3.6 + 0.34 * len(results.get("leaderboard", []))))
    draw_leaderboard(ax, results, entry_palette(entry_order(results)))
    add_meta(fig, results)
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    fig.savefig(out_dir / "01_leaderboard.png", bbox_inches="tight")
    plt.close(fig)


# --------------------------------------------------------------------------
# 图 2：场景 × 条目平均排名热图（viridis）
# --------------------------------------------------------------------------

def draw_rank_heatmap(ax: plt.Axes, results: dict, order: list[str],
                      annotate: bool = True) -> None:
    scenarios = results.get("scenarios", [])
    if not scenarios or not order:
        ax.text(0.5, 0.5, tr("无热图数据", "no heatmap data"),
                ha="center", va="center", transform=ax.transAxes)
        ax.axis("off")
        return
    rows = [s["name"] for s in scenarios]
    matrix = np.array([
        [s.get("perEntry", {}).get(eid, {}).get("avgRank", np.nan) for eid in order]
        for s in scenarios
    ], dtype=float)
    sns.heatmap(
        matrix, ax=ax, cmap="viridis", annot=annotate, fmt=".1f",
        annot_kws={"size": 7.5, "color": "white"},
        linewidths=0.6, linecolor=COLORS["bg"],
        cbar_kws={"label": tr("平均排名（低=优）", "avg rank (lower=better)"), "shrink": 0.8},
    )
    ax.set_xticks(np.arange(len(order)) + 0.5, order, rotation=45, ha="right")
    ax.set_yticks(np.arange(len(rows)) + 0.5, rows, rotation=0)
    ax.set_title(tr("场景 × 条目 平均排名热图", "Scenario × entry mean-rank heatmap"),
                 loc="left", pad=10)


def figure_rank_heatmap(results: dict, out_dir: Path) -> None:
    order = entry_order(results)
    n_scenarios = len(results.get("scenarios", []))
    fig, ax = plt.subplots(figsize=(max(7, 1.1 * len(order)), 2.2 + 0.62 * n_scenarios))
    draw_rank_heatmap(ax, results, order)
    add_meta(fig, results)
    fig.tight_layout()
    fig.savefig(out_dir / "02_rank_heatmap.png", bbox_inches="tight")
    plt.close(fig)


# --------------------------------------------------------------------------
# 图 3：击杀能力（killRate 柱状 + 首杀 tick 折线，双轴）
# --------------------------------------------------------------------------

def entry_kill_stats(results: dict, order: list[str]) -> tuple[list[float], list[float | None]]:
    """跨场景均值：killRate；有击杀场次的场均首杀 tick（全无击杀 = None）。"""
    scenarios = results.get("scenarios", [])
    kill_rates: list[float] = []
    first_kills: list[float | None] = []
    for eid in order:
        krs = [s["perEntry"][eid]["killRate"] for s in scenarios if eid in s.get("perEntry", {})]
        fks = [
            s["perEntry"][eid]["firstKillTick"]
            for s in scenarios
            if eid in s.get("perEntry", {})
            and s["perEntry"][eid].get("firstKillTick") is not None
        ]
        kill_rates.append(float(np.mean(krs)) if krs else 0.0)
        first_kills.append(float(np.mean(fks)) if fks else None)
    return kill_rates, first_kills


def draw_kill_chart(ax: plt.Axes, results: dict, colors: dict[str, tuple]) -> None:
    order = entry_order(results)
    if not order:
        ax.text(0.5, 0.5, tr("无击杀数据", "no kill data"),
                ha="center", va="center", transform=ax.transAxes)
        ax.axis("off")
        return
    kill_rates, first_kills = entry_kill_stats(results, order)
    x_pos = np.arange(len(order))
    ax.bar(x_pos, kill_rates, width=0.6, color=[colors.get(eid, "#7f8c8d") for eid in order],
           edgecolor="black", linewidth=0.4, alpha=0.94, label=tr("killRate（场均击毁）", "killRate"))
    ax.set_ylim(0, max(1.0, max(kill_rates) * 1.18))
    ax.set_ylabel(tr("killRate（场均击毁）", "killRate (cores destroyed / match)"))
    ax.set_xticks(x_pos, order, rotation=45, ha="right")

    fk_values = np.array([v if v is not None else np.nan for v in first_kills], dtype=float)
    valid = fk_values[np.isfinite(fk_values)]
    twin = ax.twinx()
    twin.plot(x_pos, fk_values, color="#333333", marker="o", markersize=4.5,
              linewidth=1.6, label=tr("场均首杀 tick（低=优）", "mean first-kill tick (lower=better)"))
    if valid.size > 0:
        twin.set_ylim(0, float(np.nanmax(valid)) * 1.22)
        twin.set_yticks(np.linspace(0, float(np.nanmax(valid)), 5).round(0))
    twin.set_ylabel(tr("场均首杀 tick（低=优）", "mean first-kill tick (lower=better)"))
    twin.grid(False)
    for xi, fk in zip(x_pos, first_kills):
        if fk is None:
            anchor = float(np.nanmax(valid)) * 0.04 if valid.size else 0.02
            twin.annotate(tr("无击杀", "no kill"), xy=(xi, anchor), xytext=(0, 3),
                          textcoords="offset points", ha="center", fontsize=6.5,
                          color=COLORS["muted"])

    handles, labels = ax.get_legend_handles_labels()
    handles2, labels2 = twin.get_legend_handles_labels()
    ax.legend(handles + handles2, labels + labels2, loc="upper right", framealpha=0.85)
    ax.set_title(tr("击杀能力", "Kill capability"), loc="left", pad=10)


def figure_kill_chart(results: dict, out_dir: Path) -> None:
    fig, ax = plt.subplots(figsize=(9, 4.4))
    draw_kill_chart(ax, results, entry_palette(entry_order(results)))
    add_meta(fig, results)
    fig.tight_layout()
    fig.savefig(out_dir / "03_kill_chart.png", bbox_inches="tight")
    plt.close(fig)


# --------------------------------------------------------------------------
# 图 4：五维画像雷达图（全部条目叠加）
# --------------------------------------------------------------------------

RADAR_DIMS = [
    ("beacon", "信标", "beacon"),
    ("economy", "经济", "economy"),
    ("expansion", "扩张", "expansion"),
    ("military", "军事", "military"),
    ("survival", "生存", "survival"),
]


def draw_radar(ax: plt.Axes, results: dict, colors: dict[str, tuple],
               legend: bool = True) -> None:
    profiles = results.get("profiles", {})
    order = [eid for eid in entry_order(results) if eid in profiles]
    if not order:
        ax.text(0.5, 0.5, tr("无画像数据", "no profile data"),
                ha="center", va="center", transform=ax.transAxes)
        return
    dims = [d[0] for d in RADAR_DIMS]
    angles = np.linspace(0, 2 * np.pi, len(dims), endpoint=False).tolist()
    angles += angles[:1]
    for eid in order:
        normalized = profiles[eid].get("normalized", {})
        values = [normalized.get(dim, 0.0) for dim in dims]
        values += values[:1]
        ax.plot(angles, values, color=colors.get(eid, "#7f8c8d"), linewidth=1.5,
                label=eid, alpha=0.95)
        ax.fill(angles, values, color=colors.get(eid, "#7f8c8d"), alpha=0.16)
    ax.set_xticks(angles[:-1], [d[1] if _CJK_OK else d[2] for d in RADAR_DIMS], fontsize=9)
    ax.set_ylim(0, 1.08)
    ax.set_yticks([0.2, 0.4, 0.6, 0.8, 1.0])
    ax.set_yticklabels(["0.2", "0.4", "0.6", "0.8", "1.0"], fontsize=6.5)
    ax.set_title(tr("五维画像（全体归一化）", "5-dim profiles (normalized)"),
                 loc="left", pad=14)
    if legend:
        ax.legend(loc="upper right", bbox_to_anchor=(1.28, 1.12), framealpha=0.9, ncol=1)


def figure_radar(results: dict, out_dir: Path) -> None:
    fig, ax = plt.subplots(figsize=(8.4, 6.2), subplot_kw={"projection": "polar"})
    draw_radar(ax, results, entry_palette(entry_order(results)))
    add_meta(fig, results)
    fig.tight_layout()
    fig.savefig(out_dir / "04_radar.png", bbox_inches="tight")
    plt.close(fig)


# --------------------------------------------------------------------------
# 图 5：关键指标分面箱线图
# --------------------------------------------------------------------------

def build_match_frame(results: dict) -> pd.DataFrame:
    """单场 × 单玩家的长表：资源效率 / 人口峰值 / 存活率。"""
    params = results.get("params", {})
    ticks = float(params.get("ticks") or 0)
    records: list[dict] = []
    for scenario in results.get("scenarios", []):
        for match in scenario.get("matches", []):
            seed = match.get("seed")
            for player_id, data in match.get("perPlayer", {}).items():
                alive = float(data.get("aliveTicks") or 0)
                survival = alive / ticks if ticks > 0 else np.nan
                if data.get("rank") is not None:
                    rank = data.get("rank")
                else:
                    rank = match.get("rank", {}).get(player_id, np.nan)
                records.append({
                    "scenario": scenario["name"],
                    "seed": seed,
                    "entry": entry_base_id(player_id),
                    "resources_per_tick": (data.get("harvested") or 0) / alive if alive > 0 else np.nan,
                    "population_peak": data.get("populationPeak") or 0,
                    "survival": survival,
                    "rank": rank,
                })
    return pd.DataFrame(records)


BOX_METRICS = [
    ("resources_per_tick", "资源效率", "resources/tick", "harvested / aliveTicks"),
    ("population_peak", "人口峰值", "population peak", "per-match populationPeak"),
    ("survival", "存活率", "survival", "aliveTicks / ticks"),
]


def draw_boxplots(axes: list[plt.Axes], results: dict, order: list[str],
                  scenario_colors: dict[str, tuple]) -> None:
    df = build_match_frame(results)
    if df.empty:
        for ax in axes:
            ax.text(0.5, 0.5, tr("无场次数据", "no match data"),
                    ha="center", va="center", transform=ax.transAxes)
            ax.axis("off")
        return
    for ax, (column, zh, en, formula) in zip(axes, BOX_METRICS):
        sns.boxplot(data=df, x="entry", y=column, hue="scenario", ax=ax,
                    order=order, palette=scenario_colors, width=0.62,
                    linewidth=0.8, fliersize=2.5, legend=False)
        if df["scenario"].nunique() > 1:
            sns.pointplot(data=df, x="entry", y=column, hue="scenario", ax=ax,
                          order=order, palette=scenario_colors, errorbar="sd",
                          markers="D", markersize=3, linestyle="none", dodge=0.28,
                          legend=False)
        ax.set_title(f"{tr(zh, en)} · {formula}", fontsize=9.5)
        ax.set_xlabel("")
        ax.set_ylabel("")
        ax.tick_params(axis="x", rotation=45)
    axes[0].legend(title=tr("场景", "scenario"), loc="upper right",
                   fontsize=7.5, title_fontsize=8, framealpha=0.9)


def figure_boxplots(results: dict, out_dir: Path) -> None:
    order = entry_order(results)
    fig, axes = plt.subplots(3, 1, figsize=(9.5, 9.6), sharex=True,
                             gridspec_kw={"hspace": 0.34})
    draw_boxplots(list(axes), results, order, scenario_palette(results.get("scenarios", [])))
    add_meta(fig, results)
    fig.tight_layout()
    fig.savefig(out_dir / "05_boxplots.png", bbox_inches="tight")
    plt.close(fig)


# --------------------------------------------------------------------------
# 图 6：逐场景汇总表（打印 + CSV + PNG 表格图）
# --------------------------------------------------------------------------

def build_summary_frame(results: dict) -> pd.DataFrame:
    records: list[dict] = []
    for scenario in results.get("scenarios", []):
        for eid, stats in scenario.get("perEntry", {}).items():
            records.append({
                "scenario": scenario["name"],
                "entry": eid,
                "resources_per_tick": stats.get("resourcesPerTick", np.nan),
                "population_peak": stats.get("populationPeak", np.nan),
                "survival_median": stats.get("survivalMedian", np.nan),
                "kill_rate": stats.get("killRate", np.nan),
                "first_kill_tick": stats.get("firstKillTick"),
                "avg_rank": stats.get("avgRank", np.nan),
            })
    return pd.DataFrame(records)


TABLE_COLUMNS = [
    ("scenario", "场景", "scenario"),
    ("entry", "条目", "entry"),
    ("resources_per_tick", "资源/tick", "res/tick"),
    ("population_peak", "人口峰值", "pop peak"),
    ("survival_median", "存活中位", "surv med"),
    ("kill_rate", "场均击杀", "killRate"),
    ("first_kill_tick", "首杀 tick", "1st kill"),
    ("avg_rank", "均排", "avg rank"),
]


def draw_summary_table(ax: plt.Axes, results: dict, colors: dict[str, tuple]) -> None:
    df = build_summary_frame(results)
    ax.axis("off")
    cell_text = []
    for _, row in df.iterrows():
        cells = []
        for column, _, _ in TABLE_COLUMNS:
            value = row[column]
            if column == "first_kill_tick":
                cells.append("—" if pd.isna(value) else f"{value:.0f}")
            elif isinstance(value, (int, float, np.number)) and not pd.isna(value):
                cells.append(f"{value:.2f}" if column != "avg_rank" else f"{value:.1f}")
            else:
                cells.append("—")
        cell_text.append(cells)
    header = [tr(zh, en) for _, zh, en in TABLE_COLUMNS]
    table = ax.table(
        cellText=cell_text, colLabels=header, cellLoc="center",
        colLoc="center", loc="center",
    )
    table.auto_set_font_size(False)
    table.set_fontsize(7)
    table.scale(1, 1.45)
    for (row_idx, col_idx), cell in table.get_celld().items():
        cell.set_edgecolor("#cccccc")
        if row_idx == 0:
            cell.set_facecolor("#e9eaeb")
            cell.set_text_props(color="#111111", fontweight="bold")
        else:
            cell.set_facecolor("#ffffff" if row_idx % 2 else "#f4f5f6")
        if col_idx == 1 and row_idx > 0:
            eid = df.iloc[row_idx - 1]["entry"]
            cell.set_facecolor(colors.get(eid, "#7f8c8d"))
            cell.set_text_props(color="#111111", fontweight="bold")
    ax.set_title(tr("逐场景汇总（perEntry 聚合）", "Per-scenario summary (perEntry aggregates)"),
                 loc="left", pad=12)


def figure_summary_table(results: dict, out_dir: Path) -> None:
    df = build_summary_frame(results)
    with pd.option_context("display.max_rows", None, "display.width", 160,
                           "display.max_columns", None):
        print(tr("逐场景汇总表", "Per-scenario summary table"))
        print(df.to_string(index=False))
    csv_path = out_dir / "06_summary_table.csv"
    df.to_csv(csv_path, index=False, encoding="utf-8-sig")
    print(f"  CSV 已保存：{csv_path}")

    n_rows = max(len(df), 1)
    fig, ax = plt.subplots(figsize=(11.5, 1.6 + 0.36 * n_rows))
    draw_summary_table(ax, results, entry_palette(entry_order(results)))
    add_meta(fig, results)
    fig.tight_layout()
    fig.savefig(out_dir / "06_summary_table.png", bbox_inches="tight")
    plt.close(fig)


# --------------------------------------------------------------------------
# 图 7：汇总图板（2×3 拼版，供发帖）
# --------------------------------------------------------------------------

def figure_overview(results: dict, out_dir: Path) -> None:
    colors = entry_palette(entry_order(results))
    order = entry_order(results)
    scenario_colors = scenario_palette(results.get("scenarios", []))

    fig = plt.figure(figsize=(15.5, 11.2))
    grid = fig.add_gridspec(2, 3, hspace=0.42, wspace=0.30)
    ax_lb = fig.add_subplot(grid[0, 0])
    ax_hm = fig.add_subplot(grid[0, 1])
    ax_kill = fig.add_subplot(grid[0, 2])
    ax_radar = fig.add_subplot(grid[1, 0], projection="polar")
    ax_tbl = fig.add_subplot(grid[1, 2])

    draw_leaderboard(ax_lb, results, colors)
    draw_rank_heatmap(ax_hm, results, order, annotate=True)
    for text in ax_hm.get_xticklabels():
        text.set_fontsize(7)
    for text in ax_hm.get_yticklabels():
        text.set_fontsize(7.5)
    draw_kill_chart(ax_kill, results, colors)
    for text in ax_kill.get_xticklabels():
        text.set_fontsize(7)
    draw_radar(ax_radar, results, colors, legend=True)
    draw_summary_table(ax_tbl, results, colors)

    box_grid = grid[1, 1].subgridspec(3, 1, hspace=0.55)
    box_axes = [fig.add_subplot(cell) for cell in box_grid]
    draw_boxplots(box_axes, results, order, scenario_colors)
    for bax in box_axes:
        for text in bax.get_xticklabels():
            text.set_fontsize(6.5)

    fig.suptitle(
        tr("arena-bench 评测汇总（FFA 擂台标准化）",
           "arena-bench evaluation summary (FFA arena)"),
        fontsize=15, fontweight="bold", y=0.99,
    )
    add_meta(fig, results)
    fig.savefig(out_dir / "07_overview.png", bbox_inches="tight")
    plt.close(fig)


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------

def build_all(results: dict, out_dir: Path) -> list[tuple[str, str]]:
    """生成全部图，返回 [(文件名, 说明)]。"""
    steps: list[tuple[str, str]] = []
    figure_leaderboard(results, out_dir)
    steps.append(("01_leaderboard.png", tr("综合榜单（条形+误差棒+标注）", "composite leaderboard (bars+error+labels)")))
    figure_rank_heatmap(results, out_dir)
    steps.append(("02_rank_heatmap.png", tr("场景×条目平均排名热图（viridis）", "scenario×entry rank heatmap (viridis)")))
    figure_kill_chart(results, out_dir)
    steps.append(("03_kill_chart.png", tr("击杀能力（killRate 柱+首杀折线双轴）", "kill capability (bar + first-kill line, dual axis)")))
    figure_radar(results, out_dir)
    steps.append(("04_radar.png", tr("五维画像雷达（全条目叠加）", "5-dim radar (all entries overlaid)")))
    figure_boxplots(results, out_dir)
    steps.append(("05_boxplots.png", tr("关键指标分面箱线图", "faceted boxplots of key metrics")))
    figure_summary_table(results, out_dir)
    steps.append(("06_summary_table.png", tr("逐场景汇总表（含 CSV）", "per-scenario summary table (+ CSV)")))
    figure_overview(results, out_dir)
    steps.append(("07_overview.png", tr("汇总图板（2×3 拼版）", "overview grid (2×3)")))
    return steps


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=tr(
            "arena-bench 评测报告 → 科研风格图集（pandas/matplotlib/seaborn）",
            "arena-bench report → scientific-style figures (pandas/matplotlib/seaborn)",
        ),
    )
    parser.add_argument("results_json", help=tr("results.json 路径", "path to results.json"))
    parser.add_argument("--out", default=None,
                        help=tr("plots 输出目录（默认 results.json 同目录/plots）",
                                "output dir (default: <results dir>/plots)"))
    args = parser.parse_args(argv)

    font_name = setup_style()
    print(f"字体：{font_name if font_name else '(未找到中文字体，使用英文)'}")

    results_path = Path(args.results_json)
    if not results_path.is_file():
        print(f"错误：找不到 {results_path}", file=sys.stderr)
        return 1
    results = load_results(results_path)
    schema = results.get("schema")
    if not schema or not schema.startswith("arena.bench.report."):
        print(f"警告：schema 不符预期（{schema!r}），仍按通用结构尝试生成", file=sys.stderr)

    out_dir = Path(args.out) if args.out else results_path.parent / "plots"
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"输出目录：{out_dir}")

    steps = build_all(results, out_dir)
    print()
    print(tr("生成结果：", "Generated:"))
    for name, description in steps:
        size = (out_dir / name).stat().st_size
        print(f"  {name:24s} {size / 1024:8.1f} KiB   {description}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
