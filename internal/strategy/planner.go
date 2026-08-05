// Package strategy 实现确定性规划器（SafetyPlanner 语义子集）。
// 当前为纵向闭环的最小合法实现：spawn/harvest/deposit/巡逻/防御 +
// Lane 2 经济化（worker 全局分配/移动容量仲裁/workerTarget reserve/
// respawn override），与 TS 版确定性规划的差分对齐在阶段 A 验收进行。
package strategy

import (
	"math"
	"sort"

	"github.com/deliciousbuding/arena/internal/domain"
)

// Config 是规划器配置（对齐 TS 版 DEFAULT_SAFETY_CONFIG）。
type Config struct {
	// Name 是策略可读名（批量评估/赛马/黄金集输出用；规划逻辑忽略）。
	Name              string
	WorkerTarget      int // 目标 Worker 数（spawn 阈值）
	PopulationCeiling int // 人口上限
	ExploreRadius     int // 探索半径
	ThreatDistance    int // 威胁判定距离（Manhattan）
	SpawnReserve      int // 正常扩张的预留资源（reserve guard；紧急/恢复期忽略）
	// MilitaryRatio 是军事单位占人口比例（百分数 0-100）：worker 达到
	// MilitarySpawnFloor 后按比例补 Vanguard/Ranger（交替）。激进策略：
	// 经济基础一到就产兵出击打野（摧毁敌方 Core 捕获资源压制对手），
	// 不等枯竭。0 = 不产军事。
	MilitaryRatio int
	// MilitarySpawnFloor 是军事产出的 worker 门槛：worker 数达到该值
	// 即开始产军事（即使未达 WorkerTarget）。激进产兵：6 个 worker
	// 维持资源循环即可，更多 worker 边际收益低。
	MilitarySpawnFloor int
	// EnableCoreMigration 启用 Core 迁移执行（红线：默认 false——
	// MIGRATE_CAND 只评估，operator 显式开启后才发 START_MOVE）。
	EnableCoreMigration bool
}

// DefaultConfig 返回默认配置（激进混合经济：worker 少而精 + 军事
// 提前产出打野）。
//   - workerTarget=8：6 格资源循环 + refill 足够维持 spawn/军事，
//     人口腾给军事（PvP 压制价值 > 第 9+ 个 worker 的边际采集）；
//   - militarySpawnFloor=6、militaryRatio=40：worker 满 6 即开始
//     按人口 40% 补军事（pop 10 → 4 军事 + 6 worker），不等枯竭；
//   - spawnReserve=0：refill 下资源持续流入，攒资源无益。
func DefaultConfig() Config {
	return Config{
		WorkerTarget:       8,
		PopulationCeiling:  16,
		ExploreRadius:      17,
		ThreatDistance:     5,
		SpawnReserve:       0,
		MilitaryRatio:      40,
		MilitarySpawnFloor: 6,
	}
}

// Planner 是确定性规划器（无副作用，不接触游戏）。
// 跨 tick 持久状态：
//   - per-unit 巡逻目标/方向/环（worker 需要走出视野发现资源格——
//     全局共享索引每 tick 换目标会让单位原地打转，真机 20t 实测根因）；
//   - 停滞指纹（服务器反馈的位置连续不变 → 强制换目标跳出死循环）；
//   - engage 计数（追敌超时跳出——敌人持续移动追不上时放弃回防）；
//   - 指挥指令（Commander 输出的模式，docs/go/08-command-design.md）。
type Planner struct {
	config        Config
	directive     Directive
	patrolTargets map[string]domain.Position // unitID → 当前巡逻目标
	patrolDirs    map[string]int             // unitID → 螺旋角度索引（64 方位角）
	patrolRings   map[string]int             // unitID → 扫描环（半径扩展）
	stuck         map[string]*stuckState     // unitID → 位置指纹停滞计数
	engageTicks   map[string]int             // unitID → 连续 engage 计数
}

// stuckState 是单位停滞指纹（基于服务器反馈的位置）。
type stuckState struct {
	lastPos    domain.Position
	stuckTicks int
}

// NewPlanner 创建规划器。
func NewPlanner(config Config) *Planner {
	return &Planner{
		config:        config,
		directive:     Directive{Mode: ModeGrowth},
		patrolTargets: make(map[string]domain.Position),
		patrolDirs:    make(map[string]int),
		patrolRings:   make(map[string]int),
		stuck:         make(map[string]*stuckState),
		engageTicks:   make(map[string]int),
	}
}

// ApplyDirective 应用指挥层指令（每 tick 由 Loop 调用；模式切换
// 确定性：同输入序列同模式序列）。
func (p *Planner) ApplyDirective(directive Directive) {
	p.directive = directive
}

// DirectiveMode 返回当前指挥模式（决策遥测/批量评估时间线用）。
func (p *Planner) DirectiveMode() DirectiveMode {
	return p.directive.Mode
}

// 停滞跳出阈值：服务器反馈的位置连续 N tick 不变（且单位有移动
// 意图）→ 强制换巡逻目标（计划合法但服务器不结算的拥挤/被占场景）。
const stuckYieldThreshold = 3

// Decide 产出确定性计划（同输入同输出）：
//  1. Core 决策（workerTarget + reserve guard + 紧急/恢复期通道）；
//  2. worker 全局资源分配（assignWorkers，每格至多一个 worker）→ 各单位动作；
//  3. 移动目标冲突仲裁（arbitrateMoveCapacity）→ 冲突格只留最高优先级
//     单位，其余降级 WAIT。
func (p *Planner) Decide(state *domain.TickState) *domain.Plan {
	plan := &domain.Plan{
		Tick:        state.Tick,
		UnitActions: make(map[string]domain.UnitAction),
		Intents:     make(map[string]string),
	}

	if coreAction := p.decideCore(state); coreAction != nil {
		plan.CoreAction = coreAction
		plan.Intents["core"] = "spawn"
	}

	assignments := assignWorkers(state)

	unitIDs := make([]string, 0, len(state.Units))
	for _, unit := range state.Units {
		unitIDs = append(unitIDs, unit.ID)
	}
	sort.Strings(unitIDs)

	var candidates []moveCandidate
	for _, id := range unitIDs {
		unit := findUnitSnapshot(state, id)
		if unit == nil {
			continue
		}
		// 停滞指纹：基于服务器反馈的位置（连续不变 = 结算未生效）。
		p.trackStuck(id, unit.Position)
		action, intent, ok := p.decideUnit(state, unit, assignments)
		if !ok {
			continue
		}
		plan.UnitActions[id] = action
		plan.Intents[id] = intent
		if action.Kind == domain.ActionMove && action.Direction != nil {
			candidates = append(candidates, moveCandidate{
				unitID:      id,
				destination: domain.Move(unit.Position, *action.Direction),
				priority:    movePriorityFor(intent),
				intent:      intent,
			})
		}
	}

	// 一次性仲裁：冲突格只保留最高优先级单位，其余降级 WAIT。
	for _, loser := range arbitrateMoveCapacity(candidates) {
		plan.UnitActions[loser.unitID] = domain.UnitAction{Kind: domain.ActionWait}
		plan.Intents[loser.unitID] = "capacity_wait:" + loser.intent
		// 仲裁降级且站在 Core 格上的任意己方单位：改为让位（仓库口让出）——
		// 空载 Worker 等 to_resource、军事单位巡逻经过，都会占住 Core 格
		// 让满载 worker 进不来 deposit（refill 闭环 + 军事生产后暴露）。
		// 空载让位允许踩资源格（dense 拓扑 Core 四邻全为资源格）。
		if unit := findUnitSnapshot(state, loser.unitID); unit != nil &&
			unit.Cargo == 0 &&
			state.Core != nil && unit.Position == state.Core.Position {
			if yield, ok := p.yieldFromCore(state, unit, false); ok {
				plan.UnitActions[loser.unitID] = yield
				plan.Intents[loser.unitID] = "yield_core_wait"
			}
		}
	}
	return plan
}

// trackStuck 更新单位停滞指纹：位置与上次一致则计数 +1（达到阈值后
// 由 patrol 触发换目标）；位置变化则重置。
func (p *Planner) trackStuck(unitID string, position domain.Position) {
	st := p.stuck[unitID]
	if st == nil {
		p.stuck[unitID] = &stuckState{lastPos: position}
		return
	}
	if st.lastPos == position {
		st.stuckTicks++
		return
	}
	st.lastPos = position
	st.stuckTicks = 0
}

// isStuck 报告单位是否处于停滞（服务器位置连续不变达阈值）。
func (p *Planner) isStuck(unitID string) bool {
	st := p.stuck[unitID]
	return st != nil && st.stuckTicks >= stuckYieldThreshold
}

// decideCore：workerTarget 消费 + reserve guard + 紧急/恢复期通道 +
// 枯竭模式军事优先（打野出击）。
//   - Core 缺失或非 NORMAL：无 core 动作（validator 亦拒绝）；
//   - 枯竭/迁移评估模式：军事优先——资源枯竭时 worker 扩张停滞，
//     转产军事单位主动出击（Ranger 优先：远程打野生存性好），
//     摧毁敌方 Core 可捕获其库存资源（官方 v0.9 机制），是枯竭
//     经济的替代收入线；上限 2 个军事（打野小队），不挤占恢复期
//     worker 生产；
//   - 正常扩张：resources >= cost + SpawnReserve 才 spawn（reserve guard）；
//   - 紧急通道：worker 数低于 emergencyWorkerFloor（<2，对齐 TS 版
//     WORKER_RECOVERY_FLOOR）或处于恢复期（respawnOverride）时，
//     resources >= cost 即 spawn（不攒 reserve）；
//   - 同 tick 至多一个 spawn（Core 动作天然单数）。
func (p *Planner) decideCore(state *domain.TickState) *domain.CoreAction {
	if state.Core == nil || state.Core.State != domain.CoreNormal {
		return nil
	}
	// Core 迁移执行（红线：默认关闭；MIGRATE_CAND 且显式启用才发）。
	// 方向朝指挥焦点（Beacon 方位）；Core 进入 MOVING 后本函数
	// 返回 nil（state 非 NORMAL），不会重复发。
	if p.config.EnableCoreMigration && p.directive.Mode == ModeMigrateCand {
		if direction := migrationDirection(p.directive.Focus, state.Core.Position); direction != nil {
			return &domain.CoreAction{Kind: domain.CoreStartMove, Direction: direction}
		}
	}
	// 枯竭模式军事优先（打野出击）：worker 扩张停滞时先产军事。
	// 恢复期（respawnOverride）不切军事——先保 worker 恢复。
	if (p.directive.Mode == ModeExploreStarved || p.directive.Mode == ModeMigrateCand) &&
		!respawnOverride(state) {
		if militaryType := p.militarySpawnStarved(state); militaryType != nil {
			cost := domain.SpawnCost(*militaryType)
			if state.Resources >= cost {
				unitType := *militaryType
				return &domain.CoreAction{Kind: domain.CoreSpawn, UnitType: &unitType}
			}
		}
	}
	// 军事生产（激进产兵优先）：worker 达 MilitarySpawnFloor 后军事
	// 分支先于 worker 继续扩张（第 floor+ 个 worker 边际收益低，人口
	// 腾给军事打野）——Vanguard/Ranger 交替。
	workers := len(state.Workers)
	if militaryType := p.militarySpawn(state, workers); militaryType != nil {
		cost := domain.SpawnCost(*militaryType)
		if state.Resources >= cost {
			unitType := *militaryType
			return &domain.CoreAction{Kind: domain.CoreSpawn, UnitType: &unitType}
		}
	}
	if workers < p.config.WorkerTarget && state.Population < p.config.PopulationCeiling {
		cost := domain.SpawnCost(domain.UnitWorker)
		reserve := p.config.SpawnReserve
		if workers < emergencyWorkerFloor || respawnOverride(state) {
			reserve = 0
		}
		// 满仓死锁防护（参数扫描发现）：reserve 超过 capacity-cost 时
		// spawn 永不触发（capacity=10、cost=5、reserve=8 → 13>10）。
		if maxReserve := state.ResourceCapacity - cost; reserve > maxReserve {
			reserve = maxReserve
		}
		if state.Resources >= cost+reserve {
			unitType := domain.UnitWorker
			return &domain.CoreAction{Kind: domain.CoreSpawn, UnitType: &unitType}
		}
	}
	if state.Core.HP < domain.CoreMaxHP && workers >= 2 {
		return &domain.CoreAction{Kind: domain.CoreHeal}
	}
	return nil
}

// militarySpawnStarved 返回枯竭模式的军事生产类型（nil = 不生产）：
// 资源枯竭时即使 worker 未达 WorkerTarget 也产军事（打野出击），
// 上限 2 个（打野小队，不无限堆军事拖垮剩余经济）。Ranger 优先
// （远程打野生存性好、可风筝）；已有 1 个时补 Vanguard（近战开路）。
func (p *Planner) militarySpawnStarved(state *domain.TickState) *domain.UnitType {
	if p.config.MilitaryRatio <= 0 {
		return nil
	}
	military := len(state.Vanguards) + len(state.Rangers)
	if military >= 2 {
		return nil
	}
	unitType := domain.UnitRanger
	if military%2 == 1 {
		unitType = domain.UnitVanguard
	}
	return &unitType
}

// militarySpawn 返回需要生产的军事单位类型（nil = 不生产）：
// worker 达到 MilitarySpawnFloor 且军事占比低于 MilitaryRatio 时，
// Vanguard/Ranger 交替（第偶数个军事 → Vanguard，奇数 → Ranger）。
// 激进产兵：经济基础一到（6 worker 维持资源循环）就产军事出击，
// 不等 worker 满编（WorkerTarget 只是 worker 扩张上限，不是军事
// 产出的前提）。
func (p *Planner) militarySpawn(state *domain.TickState, workers int) *domain.UnitType {
	if p.config.MilitaryRatio <= 0 || workers < p.config.MilitarySpawnFloor {
		return nil
	}
	military := len(state.Vanguards) + len(state.Rangers)
	expected := int(math.Ceil(float64(state.Population) * float64(p.config.MilitaryRatio) / 100))
	if military >= expected {
		return nil
	}
	unitType := domain.UnitVanguard
	if military%2 == 1 {
		unitType = domain.UnitRanger
	}
	return &unitType
}

func (p *Planner) decideUnit(state *domain.TickState, unit *domain.UnitSnapshot, assignments map[string]domain.Position) (domain.UnitAction, string, bool) {
	// 信标拾取优先。
	if state.Beacon.Status == domain.BeaconGround && state.Beacon.CarrierID == nil &&
		unit.Position == state.Beacon.Position {
		return domain.UnitAction{Kind: domain.ActionPickupBeacon}, "beacon", true
	}

	switch unit.UnitType {
	case domain.UnitWorker:
		return p.decideWorker(state, unit, assignments)
	case domain.UnitVanguard:
		return p.decideVanguard(state, unit)
	case domain.UnitRanger:
		return p.decideRanger(state, unit)
	}
	return domain.UnitAction{}, "", false
}

// moveTowardOrYield：moveToward 的停滞跳出包装——位置连续不变达
// stuckYieldThreshold 且路径第一步仍被占（环形互堵：每个单位的
// BFS 第一步都被另一个单位占着，全员 WAIT 永久互等，经济冻结）→
// 确定性让位到相邻空格打破环（优先垂直于目标方向让开，不挡通道）。
func (p *Planner) moveTowardOrYield(state *domain.TickState, unit *domain.UnitSnapshot, target domain.Position) domain.UnitAction {
	action := p.moveToward(state, unit, target)
	if action.Kind != domain.ActionWait || !p.isStuck(unit.ID) {
		return action
	}
	if aside, ok := p.stepAside(state, unit, target); ok {
		return aside
	}
	return action
}

// stepAside 让位：向相邻空位移动打破互堵。
// 方向优先级（确定性）：
//  1. 垂直于目标方向的两个方向（横向让开——不挡目标通道，且自己
//     绕开占位者；满载回 Core 与空载去资源的对称互堵场景：双方
//     各自横向让开，垂直通道腾出）；
//  2. 远离目标方向（让开目标一侧）；
//  3. 兜底 4 邻域顺序（UP→RIGHT→DOWN→LEFT）。
//
// 全部被堵返回 (false, "")。
func (p *Planner) stepAside(state *domain.TickState, unit *domain.UnitSnapshot, target domain.Position) (domain.UnitAction, bool) {
	const worldBound = 1000
	perpendicular := perpendicularTo(unit.Position, target)
	away := awayDirection(unit.Position, target)
	orders := [][]domain.Direction{perpendicular, {away}, yieldOrder}
	for _, order := range orders {
		for _, direction := range order {
			next := domain.Move(unit.Position, direction)
			if next[0] < -worldBound || next[0] > worldBound || next[1] < -worldBound || next[1] > worldBound {
				continue
			}
			if state.ObstacleCells.Contains(domain.CellKey(next[0], next[1])) {
				continue
			}
			if occupiedByAny(state, unit.ID, next) {
				continue
			}
			dir := direction
			return domain.UnitAction{Kind: domain.ActionMove, Direction: &dir}, true
		}
	}
	return domain.UnitAction{}, false
}

// perpendicularTo 返回目标方向的垂直方向列表（确定性顺序）：
// 目标主要沿 X 轴（|dx| >= |dy|）→ 让位 UP/DOWN（沿 Y 让开）；
// 目标主要沿 Y 轴 → 让位 LEFT/RIGHT。
func perpendicularTo(from, target domain.Position) []domain.Direction {
	dx := target[0] - from[0]
	dy := target[1] - from[1]
	if absInt(dx) >= absInt(dy) {
		return []domain.Direction{domain.DirectionUp, domain.DirectionDown}
	}
	return []domain.Direction{domain.DirectionLeft, domain.DirectionRight}
}

// awayDirection 返回远离目标方向的确定性方向（与目标主轴向相反）：
// 目标在左（dx<0）→ RIGHT；目标在右 → LEFT；目标在上（dy<0）→ DOWN；
// 目标在下 → UP；dx/dy 平局按 LEFT→RIGHT→UP→DOWN 优先级取反。
func awayDirection(from, target domain.Position) domain.Direction {
	dx := target[0] - from[0]
	dy := target[1] - from[1]
	switch {
	case dx < 0:
		return domain.DirectionRight
	case dx > 0:
		return domain.DirectionLeft
	case dy < 0:
		return domain.DirectionDown
	case dy > 0:
		return domain.DirectionUp
	}
	return domain.DirectionLeft
}

// absInt 返回绝对值。
func absInt(value int) int {
	if value < 0 {
		return -value
	}
	return value
}

func (p *Planner) decideWorker(state *domain.TickState, unit *domain.UnitSnapshot, assignments map[string]domain.Position) (domain.UnitAction, string, bool) {
	if unit.Cargo >= 1 {
		if state.ResourceSpace <= 0 {
			// 满仓破锁（TS 版语义）：满载 Worker 站在 Core 会永久阻塞
			// SPAWN 结算（服务端因 Core 格被占不结算）→ 确定性让位到
			// 安全相邻格（UP→RIGHT→DOWN→LEFT），SPAWN 腾出仓库空间后
			// 再回仓 DEPOSIT；不在 Core 上的满载 Worker 原地等待（长途
			// 回仓无意义，等空间出现）。
			if state.Core != nil && unit.Position == state.Core.Position {
				if action, ok := p.yieldFullCore(state, unit); ok {
					return action, "yield_full_core", true
				}
			}
			return domain.UnitAction{Kind: domain.ActionWait}, "wait_full", true
		}
		if state.Core != nil && unit.Position == state.Core.Position {
			return domain.UnitAction{Kind: domain.ActionDeposit}, "deposit", true
		}
		if state.Core != nil {
			return p.moveTowardOrYield(state, unit, state.Core.Position), "return_core", true
		}
		return domain.UnitAction{Kind: domain.ActionWait}, "wait", true
	}
	if state.ResourceCells.Contains(domain.CellKey(unit.Position[0], unit.Position[1])) {
		return domain.UnitAction{Kind: domain.ActionHarvest}, "harvest", true
	}
	// 全局分配：目标是"分给我的"资源格（每格唯一，消除抢格）。
	if target, ok := assignments[unit.ID]; ok {
		action := p.moveTowardOrYield(state, unit, target)
		if action.Kind == domain.ActionWait && state.Core != nil && unit.Position == state.Core.Position {
			// 空载 Worker 在 Core 上排队等资源格时被堵：先让位离开
			// 仓库口（t4 拓扑 refill 暴露——deposit 完的 worker 站在
			// Core 等 to_resource，满载 worker 进不来 deposit，
			// 经济循环卡死）。让位后下一 tick 再前往资源格。
			// 允许踩资源格（dense 拓扑 Core 四邻全为资源格，
			// 踩上去顺路 HARVEST）。
			if yield, ok := p.yieldFromCore(state, unit, false); ok {
				return yield, "yield_core_wait", true
			}
		}
		return action, "to_resource", true
	}
	// 无可见资源格：恢复期原地待命（不探索远处），正常期巡逻探索。
	if respawnOverride(state) {
		return domain.UnitAction{Kind: domain.ActionWait}, "defend", true
	}
	return p.patrol(state, unit), "explore", true
}

func (p *Planner) decideVanguard(state *domain.TickState, unit *domain.UnitSnapshot) (domain.UnitAction, string, bool) {
	// SWEEP（官方规则）：相邻格有敌方单位/Core → AOE 1 伤害（比逼近优先）。
	if direction := adjacentEnemySweep(state, unit.Position); direction != nil {
		dir := *direction
		return domain.UnitAction{Kind: domain.ActionSweep, Direction: &dir}, "sweep", true
	}
	if enemy := nearestEnemy(state, unit.Position, p.config.ThreatDistance); enemy != nil {
		// 追敌超时跳出（agent 智能决策跳出死循环）：敌人持续移动导致
		// 永远追不上（engage 连续 engageTimeoutTicks tick）→ 放弃追击
		// 回核心防守/巡逻，避免无限消耗（第二类停滞跳出的军事版）。
		if p.engageTicks[unit.ID] >= engageTimeoutTicks {
			p.engageTicks[unit.ID] = 0
			if state.Core != nil && unit.Position != state.Core.Position {
				return p.moveToward(state, unit, state.Core.Position), "disengage", true
			}
			return p.patrol(state, unit), "patrol", true
		}
		p.engageTicks[unit.ID]++
		return p.moveToward(state, unit, enemy.Position), "engage", true
	}
	// 打野出击（任何模式，近敌已在上方优先防御）：军事单位产出即
	// 主动进攻——朝可见敌方 Core 推进（摧毁捕获资源，官方 v0.9
	// 机制）或朝最近敌单位推进（压制对手经济）。无敌人时正常巡逻。
	if enemyCore := nearestVisibleEnemyCore(state); enemyCore != nil {
		return p.moveToward(state, unit, enemyCore.Position), "raid_core", true
	}
	if enemy := nearestEnemy(state, unit.Position, 1000); enemy != nil {
		return p.moveToward(state, unit, enemy.Position), "raid", true
	}
	// 无敌人：重置 engage 计数。
	p.engageTicks[unit.ID] = 0
	if state.Core != nil && unit.HP < domain.UnitMaxHP(unit.UnitType) {
		if unit.Position == state.Core.Position {
			return domain.UnitAction{Kind: domain.ActionHeal}, "heal", true
		}
		return p.moveToward(state, unit, state.Core.Position), "to_core_heal", true
	}
	if respawnOverride(state) {
		// 恢复期：回核心防守，不巡逻远处。
		if state.Core != nil && unit.Position != state.Core.Position {
			return p.moveToward(state, unit, state.Core.Position), "defend", true
		}
		return domain.UnitAction{Kind: domain.ActionWait}, "defend", true
	}
	return p.patrol(state, unit), "patrol", true
}

// engageTimeoutTicks 是追敌超时阈值：连续 engage 超过该 tick 数且未
// 进入 SWEEP 射程 → 放弃追击（敌人持续移动追不上的场景）。
const engageTimeoutTicks = 8

// adjacentEnemySweep 检查四方向相邻格（UP→RIGHT→DOWN→LEFT 确定性顺序），
// 返回第一个含敌方单位/Core 的方向；无相邻敌人返回 nil。
func adjacentEnemySweep(state *domain.TickState, position domain.Position) *domain.Direction {
	for _, direction := range []domain.Direction{
		domain.DirectionUp, domain.DirectionRight, domain.DirectionDown, domain.DirectionLeft,
	} {
		adjacent := domain.Move(position, direction)
		for _, enemy := range state.VisibleEnemies {
			if enemy.Position == adjacent {
				dir := direction
				return &dir
			}
		}
	}
	return nil
}

func (p *Planner) decideRanger(state *domain.TickState, unit *domain.UnitSnapshot) (domain.UnitAction, string, bool) {
	if enemy := nearestEnemy(state, unit.Position, 3); enemy != nil {
		if !domain.LineBlocked(unit.Position, enemy.Position, state.ObstacleCells) {
			// 放风筝（kite）：敌人距离 <= 2 时先拉开（近战 Vanguard 相邻
			// 格 1 伤害、Ranger 距离 2 有被反打风险）——保持射程优势。
			if domain.Chebyshev(unit.Position, enemy.Position) <= 2 {
				if action, ok := p.kiteAway(state, unit, enemy.Position); ok {
					return action, "kite", true
				}
			}
			targetID := enemy.ID
			cell := enemy.Position
			return domain.UnitAction{Kind: domain.ActionShoot, TargetID: &targetID, ExpectedCell: &cell}, "shoot", true
		}
	}
	// 打野出击（任何模式，近敌已在上方优先防御）：军事单位产出即
	// 主动进攻——朝可见敌方 Core 推进（摧毁捕获资源，官方 v0.9
	// 机制）或朝最近敌单位推进（压制对手经济）。无敌人时正常巡逻。
	if enemyCore := nearestVisibleEnemyCore(state); enemyCore != nil {
		// 进入射程（Chebyshev 5）内开火，否则逼近。
		if domain.Chebyshev(unit.Position, enemyCore.Position) <= 5 &&
			!domain.LineBlocked(unit.Position, enemyCore.Position, state.ObstacleCells) {
			targetID := enemyCore.ID
			cell := enemyCore.Position
			return domain.UnitAction{Kind: domain.ActionShoot, TargetID: &targetID, ExpectedCell: &cell}, "raid_core", true
		}
		return p.moveToward(state, unit, enemyCore.Position), "raid_core", true
	}
	if enemy := nearestEnemy(state, unit.Position, 1000); enemy != nil {
		if domain.Chebyshev(unit.Position, enemy.Position) <= 5 &&
			!domain.LineBlocked(unit.Position, enemy.Position, state.ObstacleCells) {
			targetID := enemy.ID
			cell := enemy.Position
			return domain.UnitAction{Kind: domain.ActionShoot, TargetID: &targetID, ExpectedCell: &cell}, "raid", true
		}
		return p.moveToward(state, unit, enemy.Position), "raid", true
	}
	if state.Core != nil && unit.HP < domain.UnitMaxHP(unit.UnitType) {
		if unit.Position == state.Core.Position {
			return domain.UnitAction{Kind: domain.ActionHeal}, "heal", true
		}
		return p.moveToward(state, unit, state.Core.Position), "to_core_heal", true
	}
	if respawnOverride(state) {
		// 恢复期：回核心防守，不巡逻远处。
		if state.Core != nil && unit.Position != state.Core.Position {
			return p.moveToward(state, unit, state.Core.Position), "defend", true
		}
		return domain.UnitAction{Kind: domain.ActionWait}, "defend", true
	}
	return p.patrol(state, unit), "patrol", true
}

// nearestVisibleEnemyCore 返回可见敌方 Core（VisibleEnemies 中
// Kind=="CORE" 的最近者，按 Chebyshev 距离；同距取 ID 升序）。
// 无则 nil。打野出击的优先目标：摧毁敌方 Core 可捕获其库存资源
// （官方 v0.9 Core-resource-capture 机制）。
func nearestVisibleEnemyCore(state *domain.TickState) *domain.VisibleEntity {
	var best *domain.VisibleEntity
	bestDistance := 0
	for i := range state.VisibleEnemies {
		enemy := &state.VisibleEnemies[i]
		if enemy.Kind != "CORE" {
			continue
		}
		distance := domain.Chebyshev(state.Core.Position, enemy.Position)
		if best == nil || distance < bestDistance ||
			(distance == bestDistance && enemy.ID < best.ID) {
			best = enemy
			bestDistance = distance
		}
	}
	return best
}

// kiteAway 让 Ranger 朝远离敌人的方向撤退一步（保持射程优势）。
// 方向选择：敌人反方向优先（dx/dy 反向），被堵则走正交方向；
// 全部被堵返回 ok=false（调用方降级 SHOOT）。
func (p *Planner) kiteAway(state *domain.TickState, unit *domain.UnitSnapshot, enemy domain.Position) (domain.UnitAction, bool) {
	dx := unit.Position[0] - enemy[0]
	dy := unit.Position[1] - enemy[1]
	// 反方向候选：主轴向优先（|dx| >= |dy| 时 x 反向优先）。
	preferred := make([]domain.Direction, 0, 4)
	if dx != 0 {
		if dx > 0 {
			preferred = append(preferred, domain.DirectionRight)
		} else {
			preferred = append(preferred, domain.DirectionLeft)
		}
	}
	if dy != 0 {
		if dy > 0 {
			preferred = append(preferred, domain.DirectionDown)
		} else {
			preferred = append(preferred, domain.DirectionUp)
		}
	}
	for _, direction := range []domain.Direction{
		domain.DirectionRight, domain.DirectionDown, domain.DirectionLeft, domain.DirectionUp,
	} {
		if !directionIn(direction, preferred) {
			preferred = append(preferred, direction)
		}
	}
	for _, direction := range preferred {
		next := domain.Move(unit.Position, direction)
		key := domain.CellKey(next[0], next[1])
		if state.ObstacleCells.Contains(key) || state.ResourceCells.Contains(key) {
			continue
		}
		if occupiedByAny(state, unit.ID, next) {
			continue
		}
		dir := direction
		return domain.UnitAction{Kind: domain.ActionMove, Direction: &dir}, true
	}
	return domain.UnitAction{}, false
}

// directionIn 报告 direction 是否已在列表中。
func directionIn(direction domain.Direction, directions []domain.Direction) bool {
	for _, candidate := range directions {
		if candidate == direction {
			return true
		}
	}
	return false
}

// moveToward 朝目标走一步：
//   - 地形障碍（静态）由 BFS 绕行（StepToward，与 TS 版 stepToward 同）；
//   - 其他己方单位当前位置不并入 BFS（避免拥挤时绕行横跳振荡）——
//     理想第一步的目标格被占时 WAIT 排队（等占位者离开），而不是绕远路
//     （t4 拓扑暴露：满载 worker 回仓在 Core 附近被占位者挡路时，
//     BFS 绕行路径每 tick 变化 → 位置横跳振荡、永不结算）；
//   - 目标格被占时同样 WAIT 排队——不绕行到目标相邻格（dense 拓扑
//     暴露：Core 被空载 worker 让位占住时，绕行者恰好占住让位者的
//     目标格，双方互相卡死、经济冻结；排队等让位者离开即可破环）；
//   - Core 格路径语义：目标非 Core 时 Core 格视为障碍（探索/采集路径
//     不得穿越仓库口——探索 worker 反复穿过 Core 格会堵住回仓）。
func (p *Planner) moveToward(state *domain.TickState, unit *domain.UnitSnapshot, target domain.Position) domain.UnitAction {
	// 目标格被己方单位占位：WAIT 排队（等占位者离开；不绕行——
	// 绕行会占住其他等待者的目标格，形成互卡死锁）。
	if target != unit.Position && occupiedByAny(state, unit.ID, target) {
		return domain.UnitAction{Kind: domain.ActionWait}
	}
	// 地形障碍 + Core 格（目标非 Core 时）作为 BFS 障碍。
	obstacles := state.ObstacleCells.Clone()
	if state.Core != nil && target != state.Core.Position {
		obstacles.Add(domain.CellKey(state.Core.Position[0], state.Core.Position[1]))
	}
	direction, ok := domain.StepToward(unit.Position, target, obstacles)
	if !ok {
		return domain.UnitAction{Kind: domain.ActionWait}
	}
	// 理想第一步的目标格被其他单位占据：WAIT 排队（等占位者离开），
	// 不绕行——拥挤时绕行路径每 tick 变化导致横跳振荡。
	nextCell := domain.Move(unit.Position, direction)
	if occupiedByAny(state, unit.ID, nextCell) {
		return domain.UnitAction{Kind: domain.ActionWait}
	}
	dir := direction
	return domain.UnitAction{Kind: domain.ActionMove, Direction: &dir}
}

// stepToAdjacentOf 目标格被占时走到目标相邻的可达空位等待。
// （当前 moveToward 不调用——改为 WAIT 排队；保留供诊断/测试。）
func (p *Planner) stepToAdjacentOf(state *domain.TickState, unit *domain.UnitSnapshot, target domain.Position) domain.UnitAction {
	obstacles := state.ObstacleCells.Clone()
	for _, other := range state.Units {
		if other.ID == unit.ID {
			continue
		}
		obstacles.Add(domain.CellKey(other.Position[0], other.Position[1]))
	}
	for _, direction := range []domain.Direction{
		domain.DirectionUp, domain.DirectionRight, domain.DirectionDown, domain.DirectionLeft,
	} {
		adjacent := domain.Move(target, direction)
		if adjacent == unit.Position || obstacles.Contains(domain.CellKey(adjacent[0], adjacent[1])) {
			continue
		}
		if step, ok := domain.StepToward(unit.Position, adjacent, obstacles); ok {
			dir := step
			return domain.UnitAction{Kind: domain.ActionMove, Direction: &dir}
		}
	}
	// 目标四周全被堵（含已在相邻格）：等占位者离开。
	return domain.UnitAction{Kind: domain.ActionWait}
}

// occupiedByAny 报告目标格是否被任一己方单位占据（除 excludeID 外）。
func occupiedByAny(state *domain.TickState, excludeID string, cell domain.Position) bool {
	for _, other := range state.Units {
		if other.ID == excludeID {
			continue
		}
		if other.Position == cell {
			return true
		}
	}
	return false
}

// patrol 是 per-unit 持久巡逻：同一单位持续朝同一目标直线移动直到
// 到达或受阻，才换下一个螺旋扫描目标（覆盖路径规划启发式：视野带
// 重叠保证——相邻扫描点距 ≤ 视野直径，扫描带无缝隙漏检）。
// 目标是让 worker 真正走出视野发现资源格——全局共享索引每 tick 换
// 目标会原地打转（真机 20t 资源枯竭根因）。
// 停滞跳出：服务器反馈的位置连续不变（计划合法但结算未生效）→
// 强制换目标，避免"合法但无效"的死循环。
func (p *Planner) patrol(state *domain.TickState, unit *domain.UnitSnapshot) domain.UnitAction {
	home := domain.Position{0, 0}
	if state.Core != nil {
		home = state.Core.Position
	}
	// EXPLORE_STARVED / MIGRATE_CAND：所有 worker 朝指挥焦点方向扫掠。
	if p.directive.Mode == ModeExploreStarved || p.directive.Mode == ModeMigrateCand {
		return p.starvedPatrol(state, unit, home)
	}

	target, hasTarget := p.patrolTargets[unit.ID]
	if !hasTarget || unit.Position == target || p.isStuck(unit.ID) {
		target = p.nextSpiralTarget(home, state.Beacon.Position, unit.ID)
		p.stuck[unit.ID] = &stuckState{lastPos: unit.Position} // 跳出后重置指纹
	}
	action := p.moveToward(state, unit, target)
	if action.Kind == domain.ActionWait {
		// 目标方向全被障碍阻挡：换下一个目标，避免原地卡死。
		target = p.nextSpiralTarget(home, state.Beacon.Position, unit.ID)
	}
	p.patrolTargets[unit.ID] = target
	return p.moveToward(state, unit, target)
}

// starvedPatrol 是资源枯竭模式的确定性螺旋覆盖（与普通巡逻同一
// 扫描器，焦点改为指挥焦点）：每 worker 沿自己方位角（focus 方向 +
// ID 哈希偏移）在环上等距行走，视野带重叠保证无缝隙漏检。
func (p *Planner) starvedPatrol(state *domain.TickState, unit *domain.UnitSnapshot, home domain.Position) domain.UnitAction {
	target, hasTarget := p.patrolTargets[unit.ID]
	if !hasTarget || unit.Position == target || p.isStuck(unit.ID) {
		target = p.nextSpiralTarget(home, p.directive.Focus, unit.ID)
		p.stuck[unit.ID] = &stuckState{lastPos: unit.Position}
	}
	action := p.moveToward(state, unit, target)
	if action.Kind == domain.ActionWait {
		target = p.nextSpiralTarget(home, p.directive.Focus, unit.ID)
	}
	p.patrolTargets[unit.ID] = target
	return p.moveToward(state, unit, target)
}

// nextSpiralTarget 生成下一螺旋扫描目标（覆盖路径规划启发式）：
//   - 半径：内圈优先（Core 周围是资源最可能的位置），每 ring 半径
//     步进 6（视野直径 5 + 1 重叠 → 径向扫描带无缝），持续外扩到
//     88（大世界资源可能在远距离，不能扫完内圈就重置回内圈打转），
//     到顶后重置内圈循环扫；
//   - 周向：64 方位角分辨率，角步长按半径自适应
//     （angleStep = max(1, floor(36/radius)) → 相邻扫描点距 ≤ 5，
//     与视野直径重叠——周向扫描带无缝）；半径 > 46 时每 ring 扫
//     两圈（第二圈角度错位 32，等效 128 采样）——大半径点距
//     2πr/64 > 5 会出现扫描带缝隙，双圈错位消除缝隙；
//   - 首方位：focus 方位 + 单位 ID 哈希偏移（多 worker 同时出发
//     覆盖不同方位，fixture 实测同向出发会挤在一起）。
//
// 设计依据：simsearch 随机场景 + t4 真机双重暴露——旧实现 8 方位
// 点距 6.3 格、starved 外圈点距 52 格，均大于视野直径 5，扫描带
// 之间漏检（资源 9-13 距离的稀疏场景 0 harvest 经济枯竭）。
func (p *Planner) nextSpiralTarget(home, focus domain.Position, unitID string) domain.Position {
	ring := p.patrolRings[unitID]
	radius := p.patrolScanRadius(ring)
	step := p.patrolAngleStep(radius)
	angle := p.patrolDirs[unitID]
	if radius > patrolScanRadiusMax/2 {
		// 大半径双圈扫：第二圈角度错位 32（patrolDirs 0..127，
		// 高 6 位是圈号，低 6 位加圈号×32 得实际方位角）。
		pass := p.patrolDirs[unitID] / 64
		angle = (p.patrolDirs[unitID]%64 + pass*32) % 64
	}
	target := spiralPoint(home, focus, unitID, ring, angle, radius)
	p.patrolDirs[unitID] += step
	if p.patrolDirs[unitID] >= p.patrolRingSpan(radius) {
		p.patrolDirs[unitID] = 0
		p.patrolRings[unitID]++
	}
	return target
}

// patrolScanRadiusMax 是螺旋扫描最大半径：持续外扩覆盖大世界（旧
// starved 上限 88 对齐；旧实现 8 方位上限仅 68，且重置后内圈打转）。
const patrolScanRadiusMax = 88

// patrolScanRadius 返回 ring 的扫描半径：内圈 4 起步（至少覆盖 Core
// 邻域），每 ring +6（视野直径 5 + 1 重叠），上限 88 后重置回内圈
// 循环扫（确定性覆盖，不漏任何径向带）。
func (p *Planner) patrolScanRadius(ring int) int {
	radius := 4 + 6*ring
	if radius > patrolScanRadiusMax {
		return 4
	}
	return radius
}

// patrolRingSpan 返回 ring 的周向扫描点数：半径 ≤ 46 时 64 点一圈；
// 大半径（>46）时 128 点两圈（第二圈错位 32）——点距保持 ≤ 5，
// 周向扫描带全程无缝。
func (p *Planner) patrolRingSpan(radius int) int {
	if radius > patrolScanRadiusMax/2 {
		return 128
	}
	return 64
}

// patrolAngleStep 返回半径 r 处的周向角步长（64 方位角分辨率）：
// 保证相邻扫描点距（Chebyshev）≤ 5（视野直径，含取整误差余量）→
// step = max(1, floor(36/r))（36 = 5×64/2π×1.13 保守系数，覆盖
// spiralPoint 取整后 Chebyshev 距离略大于弧长的情形）。
// 半径小（内圈）时步长大（点少但点距仍 ≤ 5），半径大时步长 1
// （最密采样）——周向扫描带全程无缝。
func (p *Planner) patrolAngleStep(radius int) int {
	step := 36 / radius
	if step < 1 {
		step = 1
	}
	return step
}

// spiralUnitVectors 是 64 方位角的预计算单位向量（索引 = 方位角 0..63，
// 顺时针：0=E、16=S、32=W、48=N）。避免热路径每目标调用
// math.Cos/Sin/Round（200 单位 × 每 tick 巡逻决策的性能热点）。
var spiralUnitVectors = func() [64][2]float64 {
	var table [64][2]float64
	for i := 0; i < 64; i++ {
		theta := float64(i) / 64 * 2 * math.Pi
		table[i] = [2]float64{math.Cos(theta), math.Sin(theta)}
	}
	return table
}()

// spiralPoint 生成环上目标点：64 方位角分辨率，方位角 = focus 方位
// （45°×8）+ 单位 ID 哈希偏移 + 环进度 angle；半径按 ring 缩放。
func spiralPoint(home, focus domain.Position, unitID string, ring, angle, radius int) domain.Position {
	base := octantOf(focus[0]-home[0], focus[1]-home[1]) * 8
	offset := 0
	for _, ch := range unitID {
		offset = (offset*31 + int(ch)) % 64
	}
	total := ((base+offset+angle)%64 + 64) % 64
	vector := spiralUnitVectors[total]
	x := home[0] + int(math.Round(vector[0]*float64(radius)))
	y := home[1] + int(math.Round(vector[1]*float64(radius)))
	return domain.Position{x, y}
}

// exploreDeltas 是八方位单位向量（与 domain.nav 同布局）。
var exploreDeltas = []domain.Position{
	{1, 0}, {1, 1}, {0, 1}, {-1, 1}, {-1, 0}, {-1, -1}, {0, -1}, {1, -1},
}

// migrationDirection 将指挥焦点方位转为 Core 迁移的四方向：
// octant 0/1→E、2/3→S、4/5→W、6/7→N。焦点与 home 重合返回 nil。
func migrationDirection(focus, home domain.Position) *domain.Direction {
	if focus == home {
		return nil
	}
	octant := octantOf(focus[0]-home[0], focus[1]-home[1])
	var direction domain.Direction
	switch octant {
	case 0, 1:
		direction = domain.DirectionRight
	case 2, 3:
		direction = domain.DirectionDown
	case 4, 5:
		direction = domain.DirectionLeft
	default:
		direction = domain.DirectionUp
	}
	return &direction
}

// octantOf 将方向向量映射到 0..7 八方位索引（与 domain exploreOctant
// 同语义：0=E,1=SE,2=S,3=SW,4=W,5=NW,6=N,7=NE，对应 exploreDeltas）。
func octantOf(dx, dy int) int {
	if dx == 0 && dy == 0 {
		return 0
	}
	angle := math.Atan2(float64(dy), float64(dx))
	octant := int(math.Round(angle / (math.Pi / 4)))
	return ((octant % 8) + 8) % 8
}

func nearestEnemy(state *domain.TickState, from domain.Position, radius int) *domain.VisibleEntity {
	var best *domain.VisibleEntity
	bestDistance := 0
	for i := range state.VisibleEnemies {
		enemy := &state.VisibleEnemies[i]
		distance := domain.Manhattan(from, enemy.Position)
		if distance > radius {
			continue
		}
		if best == nil || distance < bestDistance ||
			(distance == bestDistance && enemy.ID < best.ID) {
			best = enemy
			bestDistance = distance
		}
	}
	return best
}
