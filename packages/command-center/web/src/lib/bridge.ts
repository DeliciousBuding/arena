import { useEffect, useReducer } from "react";
import type { EngineHandle } from "../engine/types";

/** 引擎单例持有 + 事件版本（任何 emit → bump → 订阅组件重渲染）。 */
let engine: EngineHandle | null = null;
let version = 0;
const listeners = new Set<() => void>();

export function setEngine(e: EngineHandle | null): void {
  engine = e;
  bump();
}
export function getEngine(): EngineHandle | null {
  return engine;
}
export function bump(): void {
  version += 1;
  for (const fn of listeners) fn();
}
export function useEngineVersion(): number {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    listeners.add(force);
    return () => { listeners.delete(force); };
  }, []);
  return version;
}
export function useEngine(): EngineHandle | null {
  useEngineVersion();
  return engine;
}
