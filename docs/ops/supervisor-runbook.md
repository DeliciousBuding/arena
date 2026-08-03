# TenantSupervisor 运维手册

> 适用于 TS-only 运行链。Supervisor 负责进程生命周期，不持有游戏业务状态，也不自动重启 live writer。

## 1. 前置条件

- Node.js 24；
- `npm ci`、`npm run check`、`npm test` 全绿；
- `runtime/configs/t1.json` 等文件只包含 env 名，不包含 token 值；
- token 存在于 `.env`、`.env.local` 或 `~/.secrets/arena.env`；
- 没有同租户 lock、旧 writer 或未知后台进程。

```bash
npx tsx packages/arena-agent/src/cli/run-tenant.ts \
  --doctor --config=runtime/configs/t1.json
```

## 2. 安全启动

先只观察：

```bash
npm run arena:supervisor -- \
  --configs=t1,t2,t3,t4 \
  --mode=deterministic --shadow --port=8120
```

Supervisor 先绑定 Debug API 端口，再一次性校验全部 config、tenantId、路径和 secret；任何一项失败都不会 spawn child。中途 spawn 失败会回收已启动 child。

真机有界 canary 必须单独获得授权：

```bash
npm run arena:supervisor -- \
  --configs=t1 --mode=deterministic --live --live-ticks=100 --port=8120
```

不要从 shadow 直接跳到四租户 live，不要将 `hybrid + live` 作为默认模式。

## 3. 健康语义

```bash
curl http://127.0.0.1:8120/health
curl http://127.0.0.1:8120/ready
curl http://127.0.0.1:8120/tenants
curl 'http://127.0.0.1:8120/events?n=50'
curl 'http://127.0.0.1:8120/state?tenant=t1&stream=runtime'
```

- `/health` 200：Supervisor HTTP 进程可响应；
- `/ready` 200：每个 expected child 都存活，且 writer-lock PID 与 child PID 持续一致；
- `starting`：child 已 spawn，尚未拿到 lock；
- `degraded`：曾 ready，但 lock 消失或 PID 不匹配；
- `failed`：非预期错误或非零退出；
- `terminating`：已发送关停请求。

JSONL 查询最多读取每代文件末尾 256 KiB；`events?n=` 最大 200。日志按完整 JSON 行轮转，默认每流 16 MiB、保留 4 代；截断活动尾行可向前读取备份，不会加载整个长期日志。

## 4. 关闭

向 Supervisor 发送 Ctrl-C/SIGTERM。父进程通过 Node IPC 发送：

```json
{"type":"arena.shutdown"}
```

`run-tenant` 自行停止接收 Turn、关闭 client/runtime/recorder/writers、注销 listener、释放 lock并自然退出。超时后：

- Windows：`taskkill /PID <pid> /T /F`；
- POSIX：对子进程独立进程组发送 `SIGKILL`。

关闭后检查 `runtime/**/locks/*.lock` 和 `run-tenant` / `run-supervisor` 进程均不存在。

## 5. 故障处理

- `/health=200`、`/ready=503`：先看 tenant lifecycle 和 lock，不要盲目重启；
- Provider circuit open：执行路径自动退 deterministic/safety，等待 half-open 单探测；
- child 非零退出：Supervisor 标记 failed，但不会自动重启 live writer；
- submit 失败或 accepted 状态不确定：暂停该租户，先检查 outcome/receipt，不生成新的随机幂等提交；
- 端口冲突：更换 `--port` 或停止旧 DebugServer；该错误发生在 0 spawn 阶段。

## 6. TS 回滚

1. 停止 Supervisor并确认 lock/orphan=0；
2. 记录当前 commit、config hash 和 manifest；
3. 切换到已验证的稳定 TS commit/config；
4. `npm ci && npm run check && npm test`；
5. doctor → shadow → 单租户 bounded live；
6. 证据通过后逐租户恢复。

不要恢复已退役 Python runtime，也不要同时运行两个 writer。

## 7. 服务器常驻

不可变 release、外置配置、systemd 单元、健康 timer 与 secrets 权限见 [`server-deployment.md`](server-deployment.md)。代码门禁通过不等于目标服务器已完成长期 soak。
