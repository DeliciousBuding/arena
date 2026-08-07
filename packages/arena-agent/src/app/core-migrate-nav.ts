/** 核心迁移导航纯函数（2026-08-08 修复版）。
 *
 * v2 生产实证的两个缺陷：
 * 1. beaconAvoid 判定/方向错误：安全判定要求 |dx|>safe && |dy|>safe（几乎永不满足 →
 *    核心永远被信标规避劫持）；远离方向写反（核心在信标左/下 → 返回右/上，反而靠近信标）。
 *    修复：Chebyshev 距离 > safe 才判安全；圈内只做"剔除靠近方向"约束，不暴力劫持。
 * 2. 无绕障持续性：主方向被堵时 UP/DOWN gain 相同，sort 不稳定 → 每轮换方向振荡
 *    （t4 卡 x=400 实证）。修复：记忆 detourDir，主方向无正向增益时持续沿 detourDir 绕。
 */
export const BEACON: readonly [number, number] = [-11, -1];
export const DIRECTIONS = ["UP", "DOWN", "LEFT", "RIGHT"] as const;
export type Dir = (typeof DIRECTIONS)[number];
export const DELTA: Readonly<Record<Dir, [number, number]>> = {
  UP: [0, -1],
  DOWN: [0, 1],
  LEFT: [-1, 0],
  RIGHT: [1, 0],
};
const STABLE_ORD: readonly Dir[] = ["UP", "RIGHT", "DOWN", "LEFT"];

export type Pos = [number, number];

export function chebyshev(a: Pos, b: Pos): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}

/** Manhattan 距离（核心仅能沿四向移动，实际步数 = |dx|+|dy|；用于增益评分——
 *  2026-08-08 t4 生产实证：Chebyshev 增益在 dx 主导时 UP/DOWN gain 全 0、
 *  平局仲裁随机选向 → 垂直竖井里 DOWN/UP 拉锯 1.5h 卡死；Manhattan 让次轴向
 *  正确减距（DOWN 明显优于 UP），直接推进而非绕障振荡）。 */
export function manhattan(a: Pos, b: Pos): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

export function beaconDist(p: Pos): number {
  return Math.max(Math.abs(p[0] - BEACON[0]), Math.abs(p[1] - BEACON[1]));
}

function nextPos(core: Pos, d: Dir): Pos {
  return [core[0] + DELTA[d][0], core[1] + DELTA[d][1]];
}

export interface NavState {
  /** 当前绕障方向记忆（主方向无正向增益时持续沿它走，避免 UP/DOWN 振荡）。 */
  detourDir: Dir | null;
  /** 最近一次选择的方向（供停滞换向用）。 */
  lastDir: Dir | null;
  /** 最近一次核心位置（停滞检测）。 */
  lastPos: Pos | null;
  /** 位置未变轮数。 */
  stuckStreak: number;
}

/** 合并障碍集合：survey 全局测绘 ∪ calibration 当前视野（保留动态障碍感知）。 */
export function mergeObstacleSets(survey: ReadonlySet<string>, calibration: ReadonlySet<string>): Set<string> {
  const merged = new Set(survey);
  for (const c of calibration) merged.add(c);
  return merged;
}

export function createNavState(): NavState {
  return { detourDir: null, lastDir: null, lastPos: null, stuckStreak: 0 };
}

export interface Plan {
  /** null = 无可行方向（等待地形/单位变化）。 */
  dir: Dir | null;
  candidates: Dir[];
  /** 是否处于绕障模式（无正向增益）。 */
  detour: boolean;
}

/** 规划下一步：信标圈内剔除靠近方向 → 按 gain 排序；无正向增益时维持绕障方向。 */
export function planDirection(
  core: Pos,
  target: Pos,
  obstacles: ReadonlySet<string>,
  beaconSafe: number,
  state: NavState,
  recentlyFailed: ReadonlySet<string>,
): Plan {
  const base = manhattan(core, target);
  const inBeaconZone = beaconDist(core) <= beaconSafe;
  // 主轴优先仲裁（2026-08-08）：Manhattan 增益在 dx≫dy 时 LEFT/DOWN gain 可能
  // 相等（两轴都减 1）——优先减主导轴（|dx|≥|dy| 时先 LEFT/RIGHT），否则任意
  // 减轴都行但按主轴先走更稳（与 Chebyshev 历史行为一致）。
  const primaryAxis: "x" | "y" =
    Math.abs(target[0] - core[0]) >= Math.abs(target[1] - core[1]) ? "x" : "y";
  const isPrimary = (d: Dir): boolean =>
    primaryAxis === "x" ? d === "LEFT" || d === "RIGHT" : d === "UP" || d === "DOWN";
  const scored = DIRECTIONS
    .filter((d) => !obstacles.has(nextPos(core, d).join(",")))
    .map((d) => {
      const n = nextPos(core, d);
      const gain = base - manhattan(n, target);
      // 信标圈内：靠近信标的方向剔除（严格小于才算靠近，避免原地打转）
      const towardBeacon = inBeaconZone && beaconDist(n) < beaconDist(core) - 0.001;
      return { d, gain, towardBeacon };
    })
    .filter((x) => !x.towardBeacon)
    .filter((x) => !recentlyFailed.has(`${x.d}:${core.join(",")}`))
    .sort(
      (a, b) =>
        b.gain - a.gain ||
        Number(isPrimary(b.d)) - Number(isPrimary(a.d)) ||
        STABLE_ORD.indexOf(a.d) - STABLE_ORD.indexOf(b.d),
    );

  if (scored.length === 0) {
    return { dir: null, candidates: [], detour: false };
  }
  const best = scored[0];

  // 有正向增益 → 朝目标推进（重置绕障记忆）
  if (best.gain > 0) {
    state.detourDir = null;
    return { dir: best.d, candidates: scored.map((s) => s.d), detour: false };
  }

  // 无正向增益（墙边/口袋/垂直振荡区）→ 绕障模式
  const detourPool = scored.filter((s) => {
    // dx 主导 → 上下绕墙；dy 主导 → 左右绕墙
    const dx = target[0] - core[0];
    const dy = target[1] - core[1];
    return Math.abs(dx) >= Math.abs(dy) ? s.d === "UP" || s.d === "DOWN" : s.d === "LEFT" || s.d === "RIGHT";
  });
  const pool = detourPool.length > 0 ? detourPool : scored;

  // 维持记忆的绕障方向（若仍可行且未被短时回避），避免 UP/DOWN 来回
  const same = pool.find((s) => s.d === state.detourDir);
  const pick = same ?? pool[0];
  state.detourDir = pick.d;
  return { dir: pick.d, candidates: scored.map((s) => s.d), detour: true };
}

/** 停滞检测：位置未变 → 累计；达到阈值记最近方向失败并返回 true（应换向）。 */
export function notePosition(state: NavState, core: Pos, threshold: number): boolean {
  if (state.lastPos !== null && state.lastPos[0] === core[0] && state.lastPos[1] === core[1]) {
    state.stuckStreak += 1;
    if (state.stuckStreak >= threshold && state.lastDir !== null) {
      return true;
    }
  } else {
    state.stuckStreak = 0;
  }
  state.lastPos = [core[0], core[1]];
  return false;
}
