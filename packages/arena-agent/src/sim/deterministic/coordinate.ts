/**
 * 确定性原语：safe coordinate 校验（S2）。
 *
 * 官方坐标是 signed int64；JS number 只能安全表示 [-2^53+1, 2^53-1]。
 * MVP 不做 bigint 迁移，但所有输入必须 Number.isSafeInteger——
 * 超出即抛 UNSUPPORTED_COORDINATE_RANGE（fail closed，禁止静默舍入）。
 */

import type { Position } from "../../domain/model.ts";

export const UNSUPPORTED_COORDINATE_RANGE = "UNSUPPORTED_COORDINATE_RANGE";

export class UnsupportedCoordinateError extends Error {
  constructor(value: unknown) {
    super(
      `${UNSUPPORTED_COORDINATE_RANGE}: coordinate must be a JS safe integer, got ${JSON.stringify(value)}`,
    );
    this.name = "UnsupportedCoordinateError";
  }
}

export function assertSafeCoordinate(position: Position): void {
  const [x, y] = position;
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
    throw new UnsupportedCoordinateError(position);
  }
}
