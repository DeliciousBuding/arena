"""Thin official-SDK bridge for reference/arena-evolve@bef407e.

This file intentionally lives in arena-ts, not the read-only reference checkout.
The generic opponent bridge adds reference/arena-evolve to sys.path before
importing this module. We then reuse arena-evolve's own LiveAdapter so its
production SDK semantics stay the source of truth for Turn <-> Observation.
"""

from __future__ import annotations

import json
from pathlib import Path

import deploy as arena_evolve_deploy
from strategies.heuristic import HeuristicStrategy, normalize_genes


class ArenaEvolveAgent:
    """Expose arena-evolve HeuristicStrategy as choose_actions(turn)."""

    def __init__(self) -> None:
        repo_root = Path(arena_evolve_deploy.__file__).resolve().parent
        genes_path = repo_root / "genes" / "evolve_v7_best.json"
        with genes_path.open(encoding="utf-8") as genes_file:
            genes = normalize_genes(json.load(genes_file))
        self.strategy = HeuristicStrategy(genes=genes, bounds=None)
        self.adapter = arena_evolve_deploy.LiveAdapter(self.strategy)
        self.reference_commit = "bef407e"
        self.genes_file = "genes/evolve_v7_best.json"

    def choose_actions(self, turn) -> None:
        observation = self.adapter.build_observation(turn)
        plan = self.strategy.decide(observation)
        self.adapter.apply_plan(turn, plan)
