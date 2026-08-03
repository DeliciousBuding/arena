# Linux 服务器长期运行部署

> 目标：让 Arena 的纯 TypeScript Supervisor 在 Linux 服务器上长期常驻，同时保留单写者、可观测、可停止、可回滚和无孤儿进程的安全边界。
>
> 当前策略：shadow 可以自动恢复；deterministic live 在跨进程幂等键和 last accepted tick 恢复完成前，**只告警、不自动重启**。

## 1. 目录与权限

固定目录：

```text
/opt/arena/releases/<git-sha>/   不可变代码发布
/opt/arena/current               指向当前 release 的原子 symlink
/etc/arena/arena.env             0600，root:root，Supervisor 参数与 tenant secret
/etc/arena/health.env            0640，root:arena，无密钥健康参数
/etc/arena/configs/*.json        0640，root:arena，租户配置
/var/lib/arena/                  0700，arena:arena，锁/manifest/telemetry
/var/cache/arena/                npm cache
```

不要把 token、完成后的 `arena.env`、租户真实配置或运行 JSONL 放进 Git。

租户配置必须把 `baseDir` 设为统一的：

```json
"baseDir": "/var/lib/arena"
```

Supervisor 使用显式参数：

```text
--config-dir=/etc/arena/configs
--runtime-dir=/var/lib/arena
```

当显式 `runtime-dir` 与任一 tenant `baseDir` 不一致时，Supervisor 在第一个 child spawn 前 fail closed。

## 2. 服务器前置条件

- Linux + systemd；
- Node.js 24；
- npm；
- Git；
- 至少 1 GiB 运行盘剩余空间，生产建议预留更多；
- 一个无登录权限的 `arena` 系统用户；
- 时间同步和稳定出网。

创建用户与目录：

```bash
sudo useradd --system --home /var/lib/arena --shell /usr/sbin/nologin arena || true
sudo install -d -o root -g root -m 0755 /opt/arena/releases
sudo install -d -o root -g arena -m 0750 /etc/arena/configs
sudo install -d -o arena -g arena -m 0700 /var/lib/arena /var/cache/arena
```

## 3. 不可变 release

示例：

```bash
SHA=$(git rev-parse HEAD)
sudo git clone --no-local /path/to/verified-repo "/opt/arena/releases/$SHA"
cd "/opt/arena/releases/$SHA"
sudo npm ci
sudo npm run check
sudo npm test
sudo npm run schema:check
sudo npm run replay:ts
sudo npm run server:check
sudo python3 scripts/gen-status.py --check
sudo python3 scripts/docs_health.py --check
```

所有门禁通过后，才切换 symlink：

```bash
sudo ln -sfn "/opt/arena/releases/$SHA" /opt/arena/current.next
sudo mv -Tf /opt/arena/current.next /opt/arena/current
```

不要在 `/opt/arena/current` 内直接编辑代码或配置。

## 4. 配置与 secret

安装环境文件模板：

```bash
sudo install -m 0600 -o root -g root \
  /opt/arena/current/deploy/systemd/arena.env.example \
  /etc/arena/arena.env
sudoedit /etc/arena/arena.env
sudo install -m 0640 -o root -g arena \
  /opt/arena/current/deploy/systemd/health.env.example \
  /etc/arena/health.env
sudoedit /etc/arena/health.env
```

`arena.env` 仅由 Supervisor 服务读取；健康检查只读取不含 token 的 `health.env`。

复制并编辑每个租户配置：

```bash
sudo install -m 0640 -o root -g arena \
  /opt/arena/current/deploy/systemd/tenant-config.json.example \
  /etc/arena/configs/t1.json
sudoedit /etc/arena/configs/t1.json
```

四个租户使用不同的 `tenantId` 与 token env 名。配置文件只保存 env 名，不保存 token 值。

## 5. 安装 systemd 单元

```bash
sudo install -m 0644 /opt/arena/current/deploy/systemd/*.service /etc/systemd/system/
sudo install -m 0644 /opt/arena/current/deploy/systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
```

单元共同提供：

- `KillMode=control-group`：systemd 对整棵进程树负责；
- 30 秒有界停止，超时后 cgroup 强制清理；
- `ProtectSystem=strict`：release 目录只读；
- `ProtectProc=invisible`：同机非特权用户不可枚举服务进程环境；
- `NoNewPrivileges`、`PrivateTmp`、内核/控制组保护；
- CPU、内存、进程数和文件描述符上限；
- stdout/stderr 进入 journald；
- runtime 使用 systemd 管理目录；服务直接 exec 本地 `tsx`，不在运行期经过 npm。

## 6. 先运行 shadow

当前服务器 shadow 固定为 `deterministic + disabled submission`，不是 `agent-shadow`。原因是
`@earendil-works/pi-coding-agent@0.83.0` 精确携带 `undici 8.5.0`，官方 npm audit 对该版本线报告高危 HTTP 客户端公告，而上游尚无更新版本。标准 npm override 在当前 workspace 依赖图中不生效，禁止通过手工篡改 lock 或 postinstall 删除模块制造“已修复”假象。

`npm run server:check` 会读取 lock 中的实际 undici 版本；在版本低于 8.9.0 时，服务器包装器若出现 `agent-shadow` 或 `hybrid` 会直接门禁失败。恢复服务器 Pi 模式的前置条件是：

1. 上游 Pi 发布携带 patched undici 的版本，或建立有来源/许可证/完整性验证的受控本地 fork；
2. `npm ls undici --all` 显示实际运行树已修复；
3. 使用官方 npm registry 的 audit 不再报告该链路；
4. Pi session、stream、abort、rotation、circuit breaker 和全量测试重新通过。

启用 shadow 与健康计时器：

```bash
sudo systemctl disable --now arena-supervisor-live.service arena-live-health.timer 2>/dev/null || true
sudo systemctl enable --now arena-supervisor-shadow.service
sudo systemctl enable --now arena-shadow-health.timer
sudo systemctl enable --now arena-disk-health.timer
```

检查：

```bash
systemctl status arena-supervisor-shadow.service
systemctl status arena-shadow-health.timer
curl -fsS http://127.0.0.1:8120/health
curl -fsS http://127.0.0.1:8120/ready
journalctl -u arena-supervisor-shadow.service -f
```

shadow service 进程异常退出或 readiness 连续失败时可以自动恢复，因为它不拥有真实提交权，并且当前不启动 Pi Provider 请求。

## 7. 晋级 deterministic live

晋级前必须满足：

1. 当前 release SHA 和 config hash 已记录；
2. Windows/Linux 全量门禁通过；
3. shadow 稳定，四租户 `/ready` 为 true；
4. 无旧 writer、无活锁、无孤儿进程；
5. TS deterministic 回滚 release 已准备；
6. 用户明确批准 live；
7. 先按单租户和有限 Tick Canary 验收，再进入常驻。

切换：

```bash
sudo systemctl disable --now arena-shadow-health.timer arena-supervisor-shadow.service
sudo systemctl enable --now arena-supervisor-live.service
sudo systemctl enable --now arena-live-health.timer
sudo systemctl enable --now arena-disk-health.timer
```

`arena-supervisor-live.service` 固定使用：

```text
--mode=deterministic --live
```

不会因为 Provider 恢复自动开启 hybrid。

## 8. 健康与磁盘门禁

readiness 计时器每分钟验证：

- `/ready` 返回 HTTP 2xx；
- 响应体 `ready=true`；
- 检查在规定 timeout 内完成。

独立的 `arena-disk-health.timer` 每 5 分钟验证 `/var/lib/arena` 所在文件系统剩余空间高于 `ARENA_MIN_FREE_BYTES`。磁盘不足只触发 `arena-disk-alert.service`，不会重启 shadow 或 live writer。

手工执行：

```bash
cd /opt/arena/current
npm run server:healthcheck -- \
  --url=http://127.0.0.1:8120/ready \
  --runtime-dir=/var/lib/arena \
  --min-free-bytes=1073741824
```

shadow readiness 失败会触发 `arena-shadow-recover.service`。live readiness 失败只触发 daemon.crit 告警；不会自动重启 live writer。服务未启用或已经停止时，readiness probe 会安全跳过，避免 timer 制造重启/告警风暴。

所有常规 JSONL 流使用写入前 rename 轮转，不使用 `copytruncate`：

```text
active.jsonl       16 MiB
active.jsonl.1     16 MiB
...
active.jsonl.4     16 MiB
```

因此每条流本地最多约 80 MiB，轮转只发生在完整行边界；Debug API 会跨当前文件和 4 代备份读取。第 5 次轮转会删除最旧一代，这是明确的有限保留策略，不是永久归档。若需要数月级审计，应在服务器侧把即将淘汰的备份同步到对象存储；磁盘门禁仍负责在异常增长或归档失败时 fail closed。

## 9. Live 故障恢复

live service 退出或 `/ready` 失败时：

1. 不要立即 restart；
2. 查看 `journalctl -u arena-supervisor-live.service`；
3. 检查 `/var/lib/arena/<tenant>/locks`；
4. 检查最后一次 accepted receipt、tick、幂等键和服务端状态；
5. 确认不存在继续提交的旧进程；
6. 判断是继续当前 release，还是切回已验证 deterministic release；
7. 记录恢复后的首个 accepted Tick。

原因：默认提交幂等键包含随机 UUID。服务端已接受、客户端未收到响应便崩溃时，盲重启可能对同一 Tick 使用新 key 再提交。

## 10. 更新与回滚

更新：

```text
新 release clone → npm ci → 全量门禁 → shadow → Canary → 切 current symlink
```

回滚：

```bash
sudo systemctl stop arena-supervisor-live.service
sudo ln -sfn /opt/arena/releases/<known-good-sha> /opt/arena/current.next
sudo mv -Tf /opt/arena/current.next /opt/arena/current
sudo systemctl start arena-supervisor-live.service
```

回滚前后都必须确认锁、进程树和最后 accepted tick，不能只切 symlink 后立即启动。

## 11. 长期稳定验收

服务器常驻关单至少要求：

- shadow 24 小时无跨租户污染、无 orphan；
- 单租户 deterministic live 10,000 Tick；
- 四租户 deterministic 2,000 Tick 后再扩长期 soak；
- `/health` 与 `/ready` 语义持续正确；
- process tree 停止后完全清空；
- disk free 门禁和 JSONL 16 MiB × 5 代有限保留策略生效；
- Provider 故障自动退 deterministic/safety；
- live 故障恢复演练不产生重复提交；
- release/rollback 可复现；
- secret、Prompt 私密内容和 token 不进入日志。

在这些证据完成前，可以说“具备服务器部署基线”，不能说“已经无限期无人值守稳定”。
