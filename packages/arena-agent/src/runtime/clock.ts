/** 单调时钟抽象：所有 elapsed 判定必须基于单调时钟，墙钟跳变（NTP 校正/手动改时间）不得影响决策。 */

export interface Clock {
  /** 当前单调时间（ms）。只要求递增，不要求与墙钟对齐。 */
  now(): number;
}

/** 生产时钟：基于 performance.now()（规范保证单调，不受系统墙钟调整影响）。 */
export class MonotonicClock implements Clock {
  now(): number {
    return performance.now();
  }
}

/** 测试用假时钟：手动推进、瞬时生效（测试里禁止真实 sleep 等待）。
 *  只允许向前推进，保持与真实单调时钟一致的语义。 */
export class FakeClock implements Clock {
  #now: number;

  constructor(initialNow = 0) {
    this.#now = initialNow;
  }

  now(): number {
    return this.#now;
  }

  /** 精确推进 ms 毫秒，返回推进后的时间。负值/NaN/Infinity 拒绝（单调时钟不允许倒退）。 */
  advance(ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`FakeClock.advance: ms must be a finite non-negative number, got ${ms}`);
    }
    this.#now += ms;
    return this.#now;
  }
}

/** 生产便利函数 = performance.now()。 */
export function nowMs(): number {
  return performance.now();
}
