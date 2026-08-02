# Dependency Graph — 依赖图

最后更新：2026-08-02（Phase 3）

```mermaid
graph TD
    subgraph B1[Batch 1 工程基座]
        A1[A1 pyproject+uv] --> A2[A2 包结构+config]
        A2 --> A3[A3 pytest 配置]
    end
    subgraph B2[Batch 2 核心库]
        A2 --> B1[B1 日志系统]
        A2 --> B2[B2 world 环境记忆]
        A2 --> B3[B3 state 适配层]
    end
    subgraph B3[Batch 3 决策内核 I]
        B3 --> C1[C1 策略接口+Plan]
        B1 --> C2[C2 BalanceStrategy 迁移]
        B2 --> C2
        C1 --> C2
    end
    subgraph B4[Batch 4 状态机+调试]
        C2 --> C3[C3 全局阶段机]
        C2 --> C4[C4 单元状态机]
        B2 --> C4
        C2 --> D1[D1 HTTP 调试端点]
        B1 --> D1
    end
    subgraph B5[Batch 5 集成切换]
        C3 --> D2[D2 main 集成]
        C4 --> D2
        D1 --> D2
        D2 --> E1[E1 新旧对比验证]
        E1 --> E2[E2 线上切换]
        E2 --> E3[E3 文档归档]
    end
```

## 关键路径

A1 → A2 → B2 → C2 → C4 → D2 → E1 → E2

## 并行性说明

- Batch 2 内 B1/B2/B3 相互独立（仅依赖 A2），可并行——但 LOCAL_ONLY 单写者，按顺序执行
- Batch 4 内 C3/C4 与 D1 相互独立，可顺序执行（同一提交批）
- 无 worktree/多代理需求：本项目规模 Tier 0（orchestrator-direct）全程
