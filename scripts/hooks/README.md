# 防泄露 git hooks

`pre-commit` hook 在每次 `git commit` 时拦截会把隐私内容带进历史/公开仓库的暂存改动。

## 拦截清单

| 类别 | 匹配内容 |
|------|----------|
| 密钥值 | `ah_live`（真实 key 前缀）、`sk-` 长 token、`ghp_`/`github_pat_`、`AKIA`、`xox*`、`ARENA_HERO_API_KEY=<值>`、`Bearer <token>` |
| 本机路径 | `CODE_ROOT\\`、`USER_HOME\\`（Windows 绝对路径，正则转义写法） |
| 个人邮箱 | 内容中出现的 `qq.com`/`163.com`/`126.com`/`foxmail.com` 邮箱 |
| 提交者邮箱 | `git config user.email` 为个人邮箱（须用 GitHub noreply） |
| 敏感文件 | `.env`、`alerts/`、`runs/`、`runtime/`、`mapstore/`、`*.sqlite`、`*.db`、`*.jsonl` |

## 安装

```bash
sh scripts/hooks/install-hooks.sh
```

仓库 clone 到新机器后需重跑一次（hook 不在 git 内，复制到 `.git/hooks/`）。

## 豁免（慎用）

```bash
SKIP_ARENA_SECRET_CHECK=1 git commit
```

仅在确认误报时使用。

## 设计说明

- **内容检查只扫暂存新增行**（`git diff --cached` 的 `+` 行），历史既有内容不误报
- **`test/` 目录自动豁免内容检查**：测试 fixture 故意包含假密钥（如 `sk-abcdefghijklmnop123456`）；文件名检查不豁免
- 规则改动：编辑 `scripts/hooks/pre-commit` 后重跑 `install-hooks.sh` 即可生效
- 历史清理：本仓库曾用 `git filter-repo` 清除过 reflog 旧链（本机路径/QQ 邮箱），hook 是防止再次发生的前置闸门
