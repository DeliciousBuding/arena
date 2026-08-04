# 部署链路快速升级设计

> 状态：设计稿（2026-08-04）。目标：每次发版从"20 分钟 CI + 6 步手工 SSH"降到"一条命令 + 自动健康检查"，版本 pin 单源化、失败自动回滚。

## 1. 现状痛点（含 2026-08-04 实测证据）

| # | 痛点 | 实测证据 |
|---|---|---|
| P1 | **版本 pin 丢失**：compose 文件在 release 目录内，每次新建 release 目录（git clone 仓库）就回到仓库原始 `:main`，手工 sed 的 pin 修改丢失 | v0.1.8→v0.1.9 部署时 sed 匹配 `:v0.1.8` 失败（release 重建后第 57 行是 `:main`），必须二次 sed |
| P2 | **release 目录 git clone 全仓库慢且易失败** | 多次 clone 超时/网络中断（SSH 命令 90s+ 卡住） |
| P3 | **手工步骤多**：拉镜像 → clone → checkout → 软链 → sed → restart → 验证，任一环节中断留下不一致状态 | 本轮部署 3 次命令才完成（clone 失败 1 次、sed 失败 1 次） |
| P4 | **升级无自动健康门禁**：restart 后靠人肉 curl /ready | systemd restart 后容器短暂 unhealthy 期间无人值守 |
| P5 | **CI 构建串行且无缓存**：quality → docker（docker 被 needs 阻塞），每次 20 分钟 | v0.1.7-v0.1.9 三次发版实测 |

## 2. 目标架构

```
┌─ 发布（本地/CI）─────────────────────────────┐
│  ./deploy/release.sh v0.1.9                  │
│   1. 校验 tag 存在 + manifest 可拉            │
│   2. 更新 /opt/arena/version.env（单一 pin）  │
│   3. docker compose up -d --pull always      │
│   4. 健康检查（/ready 四租户 + 3 次重试）      │
│   5. 失败 → 自动回滚（恢复旧 version.env + up）│
└──────────────────────────────────────────────┘

版本 pin 单源：/opt/arena/version.env
  ARENA_LIVE_IMAGE=ghcr.io/deliciousbuding/arena:v0.1.9
  ARENA_SHADOW_IMAGE=ghcr.io/deliciousbuding/arena:main
compose 引用 ${ARENA_LIVE_IMAGE:-...main}（env_file 注入，release 重建不丢）
```

## 3. 分步实施方案

### 3.1 版本 pin 单源化（解决 P1）

1. **compose 改造**：live/shadow 服务的 `image:` 改为环境变量引用：
   ```yaml
   image: ${ARENA_LIVE_IMAGE:-ghcr.io/deliciousbuding/arena:main}
   ```
   compose 的 `env_file: /etc/arena/arena.env` 已注入（arena.env 追加两个 IMAGE 变量）。
2. **版本文件**：`/opt/arena/version.env`（独立于 release 目录，永不被 clone 覆盖），systemd unit 增加 `EnvironmentFile=/opt/arena/version.env`（在 arena.env 之后加载，优先级更高）。
3. **verify-deployment.mjs 契约更新**：断言 compose 的 live 服务 image 包含 `ARENA_LIVE_IMAGE` 环境变量引用（而非硬编码 tag）。

### 3.2 release 目录简化（解决 P2）

- release 目录只保留 compose + systemd 引用所需：**直接删除 release 目录机制**，compose 固定放在 `/opt/arena/deploy/arena-compose.yml`（独立部署区，不属于任何 git release）。
- systemd unit 的 ExecStart 引用 `/opt/arena/deploy/arena-compose.yml`。
- 镜像 tag（d620ae4 等）仍记录在 `/opt/arena/version.env` + `/opt/arena/CHANGELOG`（追加式）。
- 好处：升级不再需要 git clone；回滚 = 改 version.env 一个文件。

### 3.3 一键升级脚本（解决 P3/P4）

`deploy/upgrade.sh`（服务器 `/opt/arena/upgrade.sh`）：

```bash
#!/usr/bin/env bash
set -euo pipefail
# 用法：upgrade.sh <tag> [--rollback]
TAG="${1:?usage: upgrade.sh <tag>}"
BACKUP=/opt/arena/version.env.bak
cp /opt/arena/version.env "$BACKUP"
sed -i "s|^ARENA_LIVE_IMAGE=.*|ARENA_LIVE_IMAGE=ghcr.io/deliciousbuding/arena:${TAG}|" /opt/arena/version.env
docker pull "ghcr.io/deliciousbuding/arena:${TAG}"
docker compose -f /opt/arena/deploy/arena-compose.yml up -d --pull always live
# 健康门禁：最多 5 次 × 30s
for i in 1 2 3 4 5; do
  if curl -fsS -m 5 http://127.0.0.1:8120/ready | grep -q '"ready":true'; then
    echo "upgrade to ${TAG} OK"; exit 0
  fi
  sleep 30
done
echo "upgrade failed, rolling back"
cp "$BACKUP" /opt/arena/version.env
docker compose -f /opt/arena/deploy/arena-compose.yml up -d --pull always live
```

与 `rollback.sh` 的关系：rollback.sh 保留（镜像 tag 回滚 + compose 备份的通用助手）；upgrade.sh 是主流程（自动回滚内置）。

### 3.4 CI 加速（解决 P5）

- docker job 增加 `docker/build-push-action` 的 cache（`type=gha`）——Node deps 层命中后构建从 15 分钟降到 3-5 分钟。
- quality 与 docker **并行**（去掉 docker job 的 `needs: quality`；镜像构建不依赖测试结果——测试失败由 PR 门禁拦，tag 发版本身就是质量门禁）。

### 3.5 迁移步骤（从现状到目标）

1. PR：compose 双服务 image 改 env 引用 + verify-deployment 契约更新 + upgrade.sh 脚本入库。
2. 服务器一次性迁移：`sudo mkdir -p /opt/arena/deploy && sudo cp /opt/arena/current/deploy/docker/arena-compose.yml /opt/arena/deploy/` + 写 version.env（当前 v0.2.2）+ systemd unit 改 ExecStart 路径 + daemon-reload。
3. 用 upgrade.sh 演练一次升级 + 一次回滚（对齐 rollback drill 要求）。
4. 后续发版：`/opt/arena/upgrade.sh v0.2.3` 一条命令。

### 3.6 实施记录（2026-08-05 已完成）

- **3.1/3.2/3.3 已落地（PR #24 + 服务器迁移）**：compose env pin、/opt/arena/version.env、/opt/arena/deploy/arena-compose.yml、/opt/arena/upgrade.sh、systemd EnvironmentFile=/opt/arena/version.env + ExecStart 路径切换。v0.2.1/v0.2.2 两次升级 + systemd 重启双路径 pin 保持验证通过。
- **已修复的坑**：upgrade.sh 手动运行（sudo 清环境）时 compose 拿不到 ARENA_LIVE_IMAGE → restart_live 显式 `--env-file`；systemd unit 必须先加 EnvironmentFile 再重启。
- **后续增强（研究确认）**：部署面可从镜像抽取（`docker run --entrypoint tar <img> -C /app -cf - deploy scripts/server | tar -C /opt/arena/deploy -xzf -`）——服务器零 git 依赖，唯一网络操作是可断点重试的 docker pull（release git clone 是 bare-metal 遗留，镜像已含 /app 完整代码）。
- **CI 加速（研究确认）**：docker job 拆 build（与 quality 并行）+ push（needs [quality, build]），gha cache 复用完整生效。

## 4. 风险与回滚

- 风险 1：env 引用改动影响 shadow/live 同时——迁移演练覆盖双服务。
- 风险 2：compose 版本与镜像不匹配（新 compose 引用旧镜像字段）——upgrade.sh 每次 pull 最新 tag 且 compose 只读版本 env。
- 回滚：`upgrade.sh --rollback`（恢复 BACKUP + 重新 up）；rollback.sh 保留作为底层助手。
- verify-deployment.mjs 在 CI 持续守护新契约（版本 env 引用、upgrade.sh 存在、无硬编码 tag）。

## 5. 验收清单

- [ ] `upgrade.sh vX.Y.Z` 一条命令完成升级，四租户 ready
- [ ] 升级失败（模拟：改错 tag）自动回滚到上一版本
- [ ] release 目录机制移除后 systemd/compose 正常
- [ ] CI docker 构建 < 8 分钟（cache 命中）
- [ ] verify-deployment.mjs 全绿
