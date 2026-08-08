# lib/alliance（镜像 · 同步护栏）

> 本目录是 **镜像**，非单一源。单一源在 `packages/arena-agent/src/alliance/*`（agent 线维护）。

## 为什么复制
command-center 作为独立控制面，**不依赖 @arena/arena-agent 运行时**（单向依赖，防耦合/循环）。
联盟纯函数（snapshot/shared-intel/sightings/threat-summary/counts/roster/threat-field/types/control-types）
从 agent 侧复制过来，server.ts 用 Node 24 type stripping 直接跑。

## 同步要求
改任一测后必须同步两侧。`npm run check:alliance-sync`（或 `check:all`）会 diff 两侧，
漂移即失败——**不要只改一侧**。

## 未来
抽独立共享包（如 `packages/alliance-core`）后本目录与同步护栏可删除；当前保留以最小化
跨包构建复杂度（root workspaces 仍在迁移收尾中）。
