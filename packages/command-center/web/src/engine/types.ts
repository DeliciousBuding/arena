/** React ↔ 地图引擎（mapEngine.js）的桥接类型。 */
export interface EngineCommand {
  readonly id: string;
  readonly unitId: string;
  readonly action: Record<string, unknown>;
  readonly note?: string;
  readonly createdAt: string;
}
export interface EngineGoal {
  readonly id: string;
  readonly unitId: string;
  readonly kind: "mine" | "goto";
  readonly target: [number, number];
  readonly note?: string;
  readonly createdAt: string;
}
export interface EngineCommandState {
  readonly version?: number;
  readonly mode: "override" | "disabled";
  readonly commands: readonly EngineCommand[];
  readonly goals: readonly EngineGoal[];
  readonly updatedAt: string | null;
  readonly tenant?: string;
}
export interface EngineState {
  readonly soloTenant: string | null;
  readonly view: { readonly cx: number; readonly cy: number; readonly scale: number };
  readonly layers: Readonly<Record<string, boolean>>;
  readonly tenantsOn: Readonly<Record<string, boolean>>;
  readonly cellCount: number;
  readonly jumpPins: readonly { x: number; y: number; at: number; label: string | null }[];
  /** /api/overview 快照（mapEngine poll 拉取后 emit('overview') 同步）；
   *  暴露给 React 组件复用，避免 Sidebar/TopBar 各自独立 fetch 双拉。 */
  readonly overview?: unknown | null;
}
export interface EngineHandle {
  toggleSolo(t: string): void;
  /** 聚焦租户并定位（已聚焦则重置视野到该租户全貌）——决策流点击联动。 */
  focusTenant(t: string): void;
  exitSolo(): void;
  fitView(): void;
  fitSolo(t: string): void;
  setLayer(name: string, on: boolean): void;
  setTenantOn(t: string, on: boolean): void;
  setTab(tab: string): void;
  jumpTo(x: number, y: number, label?: string): void;
  resize(): void;
  getState(): EngineState;
  subscribe(cb: (topic: string, payload: unknown) => void): () => void;
  toast(msg: string, tone?: string): void;
}
