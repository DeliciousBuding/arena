/**
 * 确定性原语：seeded RNG（S2）。
 *
 * 模拟器所有随机性必须显式注入（refill/test 场景），禁止 Math.random()。
 * mulberry32：32-bit 种子 → [0,1) 序列，实现固定、跨平台确定。
 */

export interface SeededRng {
  /** 下一个 [0,1) 浮点。 */
  readonly next: () => number;
  /** 已消费的随机数数量（stream position，可序列化恢复）。 */
  readonly consumed: number;
}

/** mulberry32（标准 32-bit PRNG）。 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 可序列化 seeded RNG：同一 seed 产生同一序列；状态可存/恢复（含 stream position）。
 */
export function createSeededRng(seed: number): SeededRng {
  const nextRaw = mulberry32(seed);
  let consumed = 0;
  return {
    next: () => {
      consumed += 1;
      return nextRaw();
    },
    get consumed(): number {
      return consumed;
    },
  };
}
