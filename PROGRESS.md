# PROGRESS — slice/ci-base

- [x] 任务 0 前提核验：npm ci 正常；SDK 48/48、agent 21/21；schema 零漂移；node v24.14.0
- [x] 根 package.json scripts：check / test / schema:check（-w 委派两包）
- [x] 包脚本修正：SDK test 补 --experimental-transform-types（任务规格要求）
- [x] .nvmrc=24；根+两包 engines.node >=24.0.0；lockfile 已同步
- [x] .github/workflows/ci.yml：ts（node 24 + cache:npm）+ py（3.11 + uv）双 job，push main + PR
- [x] 验收三连全绿（exit 0）：check / test 69/69 / schema:check；py 侧本地 uv sync + pytest 135 passed
- [x] commit + push origin slice/ci-base
