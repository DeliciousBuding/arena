# Arena Hero Dev Lab

为 [Arena Hero](https://doc.arenahero.io/zh-Hans/) Agent 开发打造的开源工具链：**确定性模拟器、多策略混战评估、实时可视化面板**。

模拟器按官方规则实现并与官方 SDK 对齐验证；混战评估把多套社区 Agent 与自定义策略放进同一张地图自由对抗；面板实时展示各实例的决策与地图状态。

## 三大组件

### 1. 环境模拟器（`packages/arena-agent`）

- 按官方 v0.14 规则实现（动态单位价格、护盾/HP、资源刷新等），与官方 Python SDK 对齐验证
- 本地高频跑局，不用等真实游戏 tick，支持对局回放复盘
- 附带离线数据集、校准与评估工具链

### 2. 多 Agent 混战评估（`packages/arena-agent`）

- 多套策略同图同规则自由混战（FFA），输出多维统计评估
- 内置基因进化搜索（GA），自动迭代搜索最优策略参数
- 支持真实数据与模拟数据的对照评估

### 3. 实时可视化面板（`packages/command-center`）

- 实时全局地图渲染
- 多实例（账号）状态一览
- 实时事件流与对局回放（支持拖拽进度）
- 深色 / 浅色主题

## 快速开始

需要 Node.js ≥ 20 与 pnpm ≥ 10：

```bash
pnpm install --frozen-lockfile
pnpm -r check
pnpm -r test
```

跑一个模拟对局（30 tick）：

```bash
npx tsx packages/arena-agent/src/cli/run-sim.ts episode \
  --scenario packages/arena-agent/scripts/scenarios/core-evade.json \
  --ticks 30
```

多策略混战（AB 对照）：

```bash
npx tsx packages/arena-agent/src/cli/run-sim.ts ab \
  --scenario packages/arena-agent/scripts/scenarios/core-evade.json \
  --planners deterministic,safety --seeds 1,2,3 --ticks 30
```

启动可视化面板（本地开发）：

```bash
node packages/command-center/scripts/start-cc.ts
```

更多命令见 `packages/arena-agent/src/cli/run-sim.ts` 的 `--help`。

## 架构概览

```text
arena-hero-ts    官方协议 SDK（wire / turn / submit）
arena-agent      决策运行时 + 模拟器 + 混战评估
command-center   实时可视化面板
```

## 生态与参考

本项目参考了 LINUX DO 社区的多套开源 Agent 实现（用于混战评估对照），感谢各位作者：

- [Waaiging 的三模式 Agent](https://linux.do/t/topic/2721042)
- [Drew-Z 的无人值守 Agent](https://linux.do/t/topic/2703873)
- [VelvetEvening 的双策略](https://linux.do/t/topic/2715054)
- [feixingwawa 的战术客户端](https://linux.do/t/topic/2726683)
- [Torther 的进化框架](https://linux.do/t/topic/2723397)

游戏官方：[Arena Hero](https://app.arenahero.io/) · [官方文档](https://doc.arenahero.io/zh-Hans/) · [LINUX DO 发布帖](https://linux.do/t/topic/2703804)

## License

各包许可证见包内 `LICENSE` 文件（`arena-hero-ts` 为 Apache-2.0）。
