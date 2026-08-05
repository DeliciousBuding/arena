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
	WorkerTarget      int // 目标 Worker 数（spawn 阈值）
	PopulationCeiling int // 人口上限
	ExploreRadius     int // 探索半径
	ThreatDistance    int // 威胁判定距离（Manhattan）
	SpawnReserve      int // 正常扩张的预留资源（reserve guard；紧急/恢复期忽略）
	// EnableCoreMigration 启用 Core 迁移执行（红线：默认 false——
	// MIGRATE_CAND 只评估，operator 显式开启后才发 START_MOVE）。
	EnableCoreMigration bool
}

// DefaultConfig 返回默认配置。
// ExploreRadius=16：视野研究结论（官方规则 v0.13）——Worker 视野半径
// 仅 3，chunk 32×32；巡逻目标按半 chunk（16 格）量级才能系统性扫过
// chunk 边界区域，8 格起步覆盖太慢（真机 20t 只见 1 个障碍 batch）。
func DefaultConfig() Config {
	return Config{
		WorkerTarget:      8,
		PopulationCeiling: 20,
		ExploreRadius:     16,
		ThreatDistance:    5,
		SpawnReserve:      5,
	}
}

// Planner 是确定性规划器（无副作用，不接触游戏）。
// 跨 tick 持久状态：
//   - per-unit 巡逻目标/方向/环（worker 需要走出视野发现资源格——
//     全局共享索引每 tick 换目标会让单位原地打转，真机 20t 实测根因）；
//   - 停滞指纹（服务器反馈的位置连续不变 → 强制换目标跳出死循环）；
//   - 指挥指令（Commander 输出的模式，docs/go/08-command-design.md）。
type Planner struct {
	config        Config
	directive     Directive
	patrolTargets map[string]domain.Position // unitID → 当前巡逻目标
	patrolDirs    map[string]int             // unitID → 八方位索引
	patrolRings   map[string]int             // unitID → 探索环（半径扩展）
	stuck         map[string]*stuckState     // unitID → 位置指纹停滞计数
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
	}
}

// ApplyDirective 应用指挥层指令（每 tick 由 Loop 调用；模式切换
// 确定性：同输入序列同模式序列）。
func (p *Planner) ApplyDirective(directive Directive) {
	p.directive = directive
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

// decideCore：workerTarget 消费 + reserve guard + 紧急/恢复期通道。
//   - Core 缺失或非 NORMAL：无 core 动作（validator 亦拒绝）；
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
	workers := len(state.Workers)
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
			return p.moveToward(state, unit, state.Core.Position), "return_core", true
		}
		return domain.UnitAction{Kind: domain.ActionWait}, "wait", true
	}
	if state.ResourceCells.Contains(domain.CellKey(unit.Position[0], unit.Position[1])) {
		return domain.UnitAction{Kind: domain.ActionHarvest}, "harvest", true
	}
	// 全局分配：目标是"分给我的"资源格（每格唯一，消除抢格）。
	if target, ok := assignments[unit.ID]; ok {
		return p.moveToward(state, unit, target), "to_resource", true
	}
	// 无可见资源格：恢复期原地待命（不探索远处），正常期巡逻探索。
	if respawnOverride(state) {
		return domain.UnitAction{Kind: domain.ActionWait}, "defend", true
	}
	return p.patrol(state, unit), "explore", true
}

func (p *Planner) decideVanguard(state *domain.TickState, unit *domain.UnitSnapshot) (domain.UnitAction, string, bool) {
	if enemy := nearestEnemy(state, unit.Position, p.config.ThreatDistance); enemy != nil {
		return p.moveToward(state, unit, enemy.Position), "engage", true
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

func (p *Planner) decideRanger(state *domain.TickState, unit *domain.UnitSnapshot) (domain.UnitAction, string, bool) {
	if enemy := nearestEnemy(state, unit.Position, 3); enemy != nil {
		if !domain.LineBlocked(unit.Position, enemy.Position, state.ObstacleCells) {
			targetID := enemy.ID
			cell := enemy.Position
			return domain.UnitAction{Kind: domain.ActionShoot, TargetID: &targetID, ExpectedCell: &cell}, "shoot", true
		}
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

// moveToward 朝目标走一步（BFS 绕障 + 避开其他己方单位当前位置）：
// 真机 20t 停滞根因——worker 排成一排时，计划互相踩格（A 的目标格
// 是 B 的当前位置），服务器不结算移动，位置永不变。把其他单位当前
// 位置并入障碍集后，BFS 确定性绕行，计划不再互相冲突。
func (p *Planner) moveToward(state *domain.TickState, unit *domain.UnitSnapshot, target domain.Position) domain.UnitAction {
	obstacles := state.ObstacleCells.Clone()
	for _, other := range state.Units {
		if other.ID == unit.ID {
			continue
		}
		obstacles.Add(domain.CellKey(other.Position[0], other.Position[1]))
	}
	if direction, ok := domain.StepToward(unit.Position, target, obstacles); ok {
		dir := direction
		return domain.UnitAction{Kind: domain.ActionMove, Direction: &dir}
	}
	return domain.UnitAction{Kind: domain.ActionWait}
}

// patrol 是 per-unit 持久巡逻：同一单位持续朝同一目标直线移动直到
// 到达或受阻，才按八方位 × 递增环半径换下一个目标（对齐 TS 版
// patrol 语义）。目标是让 worker 真正走出视野发现资源格——全局共享
// 索引每 tick 换目标会原地打转（真机 20t 资源枯竭根因）。
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
		target = p.nextPatrolTarget(home, state.Beacon.Position, unit.ID)
		p.stuck[unit.ID] = &stuckState{lastPos: unit.Position} // 跳出后重置指纹
	}
	action := p.moveToward(state, unit, target)
	if action.Kind == domain.ActionWait {
		// 目标方向全被障碍阻挡：换下一个目标，避免原地卡死。
		target = p.nextPatrolTarget(home, state.Beacon.Position, unit.ID)
	}
	p.patrolTargets[unit.ID] = target
	return p.moveToward(state, unit, target)
}

// starvedPatrol 是资源枯竭模式的集中扫掠：所有 worker 朝指挥焦点
// （Beacon 方位）方向直线推进，半径按环扩展（16→32→48→64），
// 单位按 ID 哈希错开横向偏移形成扫掠线（覆盖走廊更宽）。
func (p *Planner) starvedPatrol(state *domain.TickState, unit *domain.UnitSnapshot, home domain.Position) domain.UnitAction {
	target, hasTarget := p.patrolTargets[unit.ID]
	if !hasTarget || unit.Position == target || p.isStuck(unit.ID) {
		ring := p.patrolRings[unit.ID]
		radius := p.config.ExploreRadius * (ring + 1)
		if radius > 64 {
			radius = p.config.ExploreRadius // 半径循环：避免无限外扩
		}
		target = p.focusTarget(home, p.directive.Focus, unit.ID, radius)
		p.patrolRings[unit.ID]++
		p.stuck[unit.ID] = &stuckState{lastPos: unit.Position}
	}
	action := p.moveToward(state, unit, target)
	if action.Kind == domain.ActionWait {
		target = p.focusTarget(home, p.directive.Focus, unit.ID, p.config.ExploreRadius)
	}
	p.patrolTargets[unit.ID] = target
	return p.moveToward(state, unit, target)
}

// focusTarget 沿 focus 方位生成扫掠目标：方向 = focus-home 的八方位
// delta，横向偏移按单位 ID 哈希错开（-2..2），形成扫掠线。
func (p *Planner) focusTarget(home, focus domain.Position, unitID string, radius int) domain.Position {
	octant := octantOf(focus[0]-home[0], focus[1]-home[1])
	delta := exploreDeltas[octant]
	// 横向偏移：与主方向垂直（旋转 90°）的错开。
	lateral := 0
	if radius > 0 {
		for _, ch := range unitID {
			lateral = (lateral*31 + int(ch)) % 5
		}
		lateral -= 2 // -2..2
	}
	perpendicular := domain.Position{-delta[1], delta[0]}
	return domain.Position{
		home[0] + delta[0]*radius + perpendicular[0]*lateral,
		home[1] + delta[1]*radius + perpendicular[1]*lateral,
	}
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

// nextPatrolTarget 生成下一巡逻目标：per-unit 八方位方向索引递增，
// 每轮 8 个方向后探索环 +1（半径 ×1×2×3×4 循环，对齐
// domain.ExploreRadiusForRing 语义）。首目标方向按单位 ID 稳定分散
// （多 worker 同时出发时覆盖不同方位，fixture 实测同向出发会挤在一起）。
func (p *Planner) nextPatrolTarget(home, beacon domain.Position, unitID string) domain.Position {
	initial := p.patrolDirs[unitID]
	if initial == 0 {
		// 首目标：以 beacon 方位为基准 + 单位 ID 哈希偏移（0..7），
		// 同 tick 多单位覆盖 8 个不同方位。
		offset := 0
		for _, ch := range unitID {
			offset = (offset*31 + int(ch)) % 8
		}
		initial = offset
		p.patrolDirs[unitID] = initial
	}
	radius, _ := domain.ExploreRadiusForRing(p.config.ExploreRadius, p.patrolRings[unitID])
	target := domain.ExploreTarget(home, beacon, initial, radius)
	p.patrolDirs[unitID] = (initial + 1) % 8
	if p.patrolDirs[unitID] == 0 {
		p.patrolRings[unitID]++
	}
	return target
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
