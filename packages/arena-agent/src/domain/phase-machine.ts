export type GamePhase = "early_expansion" | "balanced" | "military";

export interface PhaseConfig {
  readonly militaryPopulation: number;
  readonly threatEnemyNear: number;
  readonly balancedPopulation: number;
  readonly balancedResources: number;
}

export const DEFAULT_PHASE_CONFIG: PhaseConfig = Object.freeze({
  militaryPopulation: 18,
  threatEnemyNear: 2,
  balancedPopulation: 5,
  balancedResources: 20,
});

export class PhaseMachine {
  private current: GamePhase = "early_expansion";
  private forced: GamePhase | null = null;

  constructor(private readonly config: PhaseConfig = DEFAULT_PHASE_CONFIG) {}

  get phase(): GamePhase {
    return this.forced ?? this.current;
  }

  update(input: { population: number; resources: number; enemyNearCore: number }): GamePhase {
    if (this.forced !== null) return this.forced;
    if (
      input.enemyNearCore >= this.config.threatEnemyNear ||
      input.population >= this.config.militaryPopulation
    ) {
      this.current = "military";
    } else if (
      input.population >= this.config.balancedPopulation &&
      input.resources >= this.config.balancedResources
    ) {
      this.current = "balanced";
    } else {
      this.current = "early_expansion";
    }
    return this.current;
  }

  force(phase: GamePhase | null): void {
    this.forced = phase;
  }
}
