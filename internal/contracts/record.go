// Package contracts 是 Arena Go 版的契约层唯一事实源：服务器 wire 协议
// （wire.go）、差分 fixture record 与 manifest（record.go）、arena_plan /
// arena_map 工具协议（plan.go）的结构体、JSON 编解码与值域校验。
//
// 设计约定（docs/go/02-contracts.md）：
//   - JSON Schema 黄金文件只读不生成；本包手写结构体 + 手写校验函数；
//   - 结构体 JSON 标签与 hero SDK / 黄金 schema 的字段名逐一对应；
//   - 解析 = 反序列化 + 校验（校验失败即拒绝），未知枚举/未知 kind 拒绝；
//   - 字段宽松度分层：wire/fixture（record、manifest、CommandPlan、回执）
//     按 02-contracts.md §4 对未知字段忽略不阻断（服务器协议升级前向兼容）；
//     arena_plan / arena_map（frozen schema，additionalProperties: false）
//     严格拒绝未知字段——契约冻结策略要求 Go 结构体与 schema 同步升级；
//   - 领域层（internal/domain）不得直接 import encoding/json，一律经本包转换。
package contracts

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
)

// Position 是网格坐标 [x, y]，对应 hero SDK PositionSchema（长度为 2 的整数数组）。
// 自定义反序列化强制恰好 2 个元素（schema minItems/maxItems 均为 2），
// 拒绝 [1] / [1,2,3] 这类错误形状。
type Position [2]int

// UnmarshalJSON 实现 encoding/json.Unmarshaler：长度必须恰为 2。
func (p *Position) UnmarshalJSON(data []byte) error {
	var cells []int
	if err := json.Unmarshal(data, &cells); err != nil {
		return fmt.Errorf("position must be an array of 2 integers: %w", err)
	}
	if len(cells) != 2 {
		return fmt.Errorf("position must have exactly 2 elements, got %d", len(cells))
	}
	p[0], p[1] = cells[0], cells[1]
	return nil
}

// ObjectKind 是差分 record / 服务器 state 中世界对象的 kind 判别字段。
type ObjectKind string

const (
	ObjectKindObstacle ObjectKind = "OBSTACLE"
	ObjectKindCore     ObjectKind = "CORE"
	ObjectKindUnit     ObjectKind = "UNIT"
	ObjectKindResource ObjectKind = "RESOURCE"
)

// KnownObjectKinds 返回当前已知的对象 kind 全集。
// 服务器若新增 kind，须按 02-contracts.md 的契约冻结策略显式加入本集合
// 并同步黄金对齐测试，禁止静默放行未知 kind。
func KnownObjectKinds() []ObjectKind {
	return []ObjectKind{ObjectKindObstacle, ObjectKindCore, ObjectKindUnit, ObjectKindResource}
}

// ValidObjectKind 报告 kind 是否在已知集合内。
func ValidObjectKind(kind ObjectKind) bool {
	for _, known := range KnownObjectKinds() {
		if kind == known {
			return true
		}
	}
	return false
}

// PlayerStatus 是玩家生命周期状态（hero SDK PlayerStatus）。
type PlayerStatus string

const (
	PlayerStatusActive     PlayerStatus = "ACTIVE"
	PlayerStatusRespawning PlayerStatus = "RESPAWNING"
)

// ValidPlayerStatus 报告状态是否在枚举内。
func ValidPlayerStatus(status PlayerStatus) bool {
	return status == PlayerStatusActive || status == PlayerStatusRespawning
}

// CoreState 是 Core 的移动状态（hero SDK CoreState）。
type CoreState string

const (
	CoreStateNormal CoreState = "NORMAL"
	CoreStateMoving CoreState = "MOVING"
)

// ValidCoreState 报告状态是否在枚举内。
func ValidCoreState(state CoreState) bool {
	return state == CoreStateNormal || state == CoreStateMoving
}

// BeaconStatus 是 Champion Beacon 的可见状态（hero SDK BeaconStatus）。
type BeaconStatus string

const (
	BeaconStatusGround  BeaconStatus = "GROUND"
	BeaconStatusCarried BeaconStatus = "CARRIED"
)

// ValidBeaconStatus 报告状态是否在枚举内。
func ValidBeaconStatus(status BeaconStatus) bool {
	return status == BeaconStatusGround || status == BeaconStatusCarried
}

// ChampionBeacon 是 Champion Beacon 的可见信息（hero SDK ChampionBeacon）。
// status/carrier_id 允许缺失或 null，语义关系见 ValidateChampionBeacon。
type ChampionBeacon struct {
	Position  Position      `json:"position"`
	Status    *BeaconStatus `json:"status"`
	CarrierID *string       `json:"carrier_id"`
}

// Object 是世界对象：以 Kind 判别 + 宽松字段承载三种变体
// （TerrainView / CoreView / UnitView，hero SDK WorldObject）。
//   - OBSTACLE / RESOURCE：仅 positions（可见的无 UUID 地形格批次）；
//   - CORE：id / controlled / owner_username / position / hp / shield /
//     state / move_* / destination；
//   - UNIT：id / controlled / position / hp / unit_type / cargo。
//
// 指针字段区分"缺失/null"与真实值，omitempty 保证序列化时只输出
// 该 kind 实际携带的字段（与 SDK 各变体的精确字段集一致）。
type Object struct {
	Kind              ObjectKind `json:"kind"`
	Positions         []Position `json:"positions,omitempty"`
	ID                string     `json:"id,omitempty"`
	Controlled        *bool      `json:"controlled,omitempty"`
	OwnerUsername     string     `json:"owner_username,omitempty"`
	Position          *Position  `json:"position,omitempty"`
	HP                *int       `json:"hp,omitempty"`
	Shield            *int       `json:"shield,omitempty"`
	UnitType          string     `json:"unit_type,omitempty"`
	Cargo             *int       `json:"cargo,omitempty"`
	State             string     `json:"state,omitempty"`
	MoveDirection     *Direction `json:"move_direction,omitempty"`
	MoveProgress      *int       `json:"move_progress,omitempty"`
	MoveRequiredTicks *int       `json:"move_required_ticks,omitempty"`
	Destination       *Position  `json:"destination,omitempty"`
}

// Event 是上一 Tick 结算产生的单个事件（hero SDK ResolutionEvent）。
// event_type 与 values 保持自由字符串/自由对象（服务器私有，不设枚举）；
// 未知字段按宽松语义忽略。
type Event struct {
	EventID    string         `json:"event_id"`
	Tick       int            `json:"tick"`
	EventType  string         `json:"event_type"`
	ReasonCode *string        `json:"reason_code,omitempty"`
	ActorID    *string        `json:"actor_id,omitempty"`
	TargetID   *string        `json:"target_id,omitempty"`
	Position   *Position      `json:"position,omitempty"`
	Values     map[string]any `json:"values,omitempty"`
}

// DifferentialRecord 是差分 fixture 的单 tick raw-state 记录（02-contracts.md
// §3，字段与 fixtures/differential/burnin-20260802-a/*.json 实际布局一致），
// 同时是服务器 state 消息的载荷结构（wire.go 的 PlayerState 即本类型别名）。
type DifferentialRecord struct {
	Status         PlayerStatus   `json:"status"`
	RespawnAtTick  *int           `json:"respawn_at_tick,omitempty"`
	Resources      int            `json:"resources"`
	Population     int            `json:"population"`
	PopulationTier int            `json:"population_tier"`
	UpkeepNextTick int            `json:"upkeep_next_tick"`
	ChampionBeacon ChampionBeacon `json:"champion_beacon"`
	Objects        []Object       `json:"objects"`
	Events         []Event        `json:"events"`
}

// ValidateChampionBeacon 校验 beacon 的值域与关系不变量
// （hero SDK checkBeaconRelations：CARRIED 必须有 carrier_id，
// 非 CARRIED 不得有 carrier_id）。
func ValidateChampionBeacon(beacon *ChampionBeacon) error {
	if beacon == nil {
		return errors.New("champion_beacon is nil")
	}
	if beacon.Status != nil && !ValidBeaconStatus(*beacon.Status) {
		return fmt.Errorf("invalid beacon status %q", *beacon.Status)
	}
	if beacon.Status != nil && *beacon.Status == BeaconStatusCarried && beacon.CarrierID == nil {
		return errors.New("carrier_id is required when status is CARRIED")
	}
	if (beacon.Status == nil || *beacon.Status != BeaconStatusCarried) && beacon.CarrierID != nil {
		return errors.New("carrier_id is only valid when status is CARRIED")
	}
	return nil
}

// ValidateObject 按 kind 判别校验对象：值域、必填字段、关系不变量
// （hero SDK CoreView/UnitView 字段级约束 + checkCoreRelations/
// checkUnitRelations）。
func ValidateObject(object *Object) error {
	if object == nil {
		return errors.New("object is nil")
	}
	switch object.Kind {
	case ObjectKindObstacle, ObjectKindResource:
		if len(object.Positions) == 0 {
			return fmt.Errorf("object kind %s requires non-empty positions", object.Kind)
		}
	case ObjectKindCore:
		if object.ID == "" {
			return errors.New("CORE object requires id")
		}
		if object.Controlled == nil {
			return errors.New("CORE object requires controlled")
		}
		if object.OwnerUsername == "" {
			return errors.New("CORE object requires owner_username")
		}
		if object.Position == nil {
			return errors.New("CORE object requires position")
		}
		if object.HP == nil || *object.HP < 0 {
			return errors.New("CORE object requires hp >= 0")
		}
		if object.Shield == nil || *object.Shield < 0 {
			return errors.New("CORE object requires shield >= 0")
		}
		switch CoreState(object.State) {
		case CoreStateNormal:
			if object.MoveDirection != nil || object.MoveProgress != nil ||
				object.MoveRequiredTicks != nil || object.Destination != nil {
				return errors.New("NORMAL Core cannot contain movement fields")
			}
		case CoreStateMoving:
			if object.MoveDirection == nil || object.MoveProgress == nil ||
				object.MoveRequiredTicks == nil || object.Destination == nil {
				return errors.New("MOVING Core requires all movement fields")
			}
		default:
			return fmt.Errorf("invalid CORE state %q", object.State)
		}
	case ObjectKindUnit:
		if object.ID == "" {
			return errors.New("UNIT object requires id")
		}
		if object.Controlled == nil {
			return errors.New("UNIT object requires controlled")
		}
		if object.Position == nil {
			return errors.New("UNIT object requires position")
		}
		if object.HP == nil || *object.HP < 0 {
			return errors.New("UNIT object requires hp >= 0")
		}
		if !ValidUnitType(UnitType(object.UnitType)) {
			return fmt.Errorf("invalid unit_type %q", object.UnitType)
		}
		if object.Cargo != nil && (!*object.Controlled || UnitType(object.UnitType) != UnitTypeWorker) {
			return errors.New("cargo is only valid for a controlled Worker")
		}
	default:
		return fmt.Errorf("unknown object kind %q", object.Kind)
	}
	return nil
}

// ValidateEvent 校验事件的值域（hero SDK ResolutionEventSchema：
// event_id/event_type 必填、tick >= 1；event_type 与 values 保持自由）。
func ValidateEvent(event *Event) error {
	if event == nil {
		return errors.New("event is nil")
	}
	if event.EventID == "" {
		return errors.New("event requires event_id")
	}
	if event.Tick < 1 {
		return fmt.Errorf("event tick must be >= 1, got %d", event.Tick)
	}
	if event.EventType == "" {
		return errors.New("event requires event_type")
	}
	return nil
}

// ValidateDifferentialRecord 校验整条 raw-state 记录的值域与关系不变量
// （hero SDK checkPlayerStateRelations 的 Go 对位）。
func ValidateDifferentialRecord(record *DifferentialRecord) error {
	if record == nil {
		return errors.New("record is nil")
	}
	if !ValidPlayerStatus(record.Status) {
		return fmt.Errorf("invalid status %q", record.Status)
	}
	if record.Status == PlayerStatusActive && record.RespawnAtTick != nil {
		return errors.New("ACTIVE state cannot contain respawn_at_tick")
	}
	if record.Status == PlayerStatusRespawning &&
		(record.RespawnAtTick == nil || *record.RespawnAtTick < 1) {
		return errors.New("RESPAWNING state requires respawn_at_tick >= 1")
	}
	if record.Resources < 0 {
		return fmt.Errorf("resources must be >= 0, got %d", record.Resources)
	}
	if record.Population < 0 {
		return fmt.Errorf("population must be >= 0, got %d", record.Population)
	}
	if record.PopulationTier < 0 {
		return fmt.Errorf("population_tier must be >= 0, got %d", record.PopulationTier)
	}
	if record.UpkeepNextTick < 0 {
		return fmt.Errorf("upkeep_next_tick must be >= 0, got %d", record.UpkeepNextTick)
	}
	if err := ValidateChampionBeacon(&record.ChampionBeacon); err != nil {
		return fmt.Errorf("champion_beacon: %w", err)
	}
	for i := range record.Objects {
		if err := ValidateObject(&record.Objects[i]); err != nil {
			return fmt.Errorf("objects[%d]: %w", i, err)
		}
	}
	for i := range record.Events {
		if err := ValidateEvent(&record.Events[i]); err != nil {
			return fmt.Errorf("events[%d]: %w", i, err)
		}
	}
	return nil
}

// ParseDifferentialRecord 解析一条差分 fixture record（或服务器 state 载荷）：
// 反序列化 + 全量校验。未知字段忽略（宽松字段语义，前向兼容），
// 未知枚举 / 未知 kind / 关系不变量违规一律拒绝。
func ParseDifferentialRecord(data []byte) (*DifferentialRecord, error) {
	var record DifferentialRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return nil, fmt.Errorf("parse differential record: %w", err)
	}
	if err := ValidateDifferentialRecord(&record); err != nil {
		return nil, fmt.Errorf("invalid differential record: %w", err)
	}
	return &record, nil
}

// ParseRecordFile 读取并解析单个 record 文件（fixture 路径）。
func ParseRecordFile(path string) (*DifferentialRecord, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read record file %s: %w", path, err)
	}
	record, err := ParseDifferentialRecord(data)
	if err != nil {
		return nil, fmt.Errorf("record file %s: %w", path, err)
	}
	return record, nil
}

// MapMode 是共享地图模式枚举（manifest-v1 与 record-v1 通用）。
type MapMode string

const (
	MapModeDisabled   MapMode = "disabled"
	MapModeFrozen     MapMode = "frozen"
	MapModeControlled MapMode = "controlled"
)

// ValidMapMode 报告模式是否在枚举内。
func ValidMapMode(mode MapMode) bool {
	return mode == MapModeDisabled || mode == MapModeFrozen || mode == MapModeControlled
}

// Manifest 是差分 fixture manifest（manifest-v1.schema.json 的 Go 表示，
// 字段以 fixtures/differential/burnin-20260802-a/manifest.json 实际内容
// 交叉验证：segments 驱动回放顺序，decision_config 单源注入决策配置）。
type Manifest struct {
	ProtocolVersion int                     `json:"protocol_version"`
	DatasetID       string                  `json:"dataset_id"`
	Source          string                  `json:"source"`
	TenantID        string                  `json:"tenant_id"`
	Segments        []ManifestSegment       `json:"segments"`
	Gaps            []ManifestGap           `json:"gaps"`
	Inputs          map[string]ManifestFile `json:"inputs"`
	BadFiles        []ManifestBadFileEntry  `json:"bad_files,omitempty"`
	MapMode         MapMode                 `json:"map_mode"`
	DecisionConfig  map[string]any          `json:"decision_config"`
	ConfigHash      string                  `json:"config_hash"`
}

// ManifestSegment 是 manifest 中的一个连续回放段。
type ManifestSegment struct {
	SegmentID string `json:"segment_id"`
	Ticks     []int  `json:"ticks"`
}

// ManifestGap 是 manifest 中相邻 tick 之间缺失的记录区间。
type ManifestGap struct {
	After        int `json:"after"`
	Before       int `json:"before"`
	MissingCount int `json:"missing_count"`
}

// ManifestFile 是 manifest 中单个输入文件的完整性信息。
type ManifestFile struct {
	SHA256 string `json:"sha256"`
	Size   int    `json:"size"`
}

// ManifestBadFileEntry 兼容 bad_files 的两种元素形态：
//   - 纯 tick 数字（burnin-20260802-a 实际 manifest 使用，47 个）；
//   - {tick, error} 对象（manifest-v1.schema.json 声明形态）。
//
// manifest-v1.schema.json 与真实 manifest.json 在此字段存在分歧
// （schema 声明对象形态，数据为数字形态），两形态都必须接受——
// 见 docs/go/02-contracts.md 的"以 schema 与 fixture 交叉验证"原则。
// 序列化时 error 为空回退为数字形态（往返稳定）。
type ManifestBadFileEntry struct {
	Tick  int
	Error string

	// fromNumber 标记本条来自数字形态（仅用于校验：数字形态允许 error 为空）。
	fromNumber bool
}

// UnmarshalJSON 先尝试数字形态，失败再尝试对象形态。
func (e *ManifestBadFileEntry) UnmarshalJSON(data []byte) error {
	var tick int
	if err := json.Unmarshal(data, &tick); err == nil {
		e.Tick = tick
		e.Error = ""
		e.fromNumber = true
		return nil
	}
	var object struct {
		Tick  int    `json:"tick"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(data, &object); err != nil {
		return errors.New("bad file entry must be a tick number or a {tick, error} object")
	}
	e.Tick = object.Tick
	e.Error = object.Error
	e.fromNumber = false
	return nil
}

// MarshalJSON 以 error 是否为空决定输出数字还是对象形态。
func (e ManifestBadFileEntry) MarshalJSON() ([]byte, error) {
	if e.Error == "" {
		return json.Marshal(e.Tick)
	}
	return json.Marshal(struct {
		Tick  int    `json:"tick"`
		Error string `json:"error"`
	}{Tick: e.Tick, Error: e.Error})
}

// sha256HashPattern 匹配 "sha256:" 前缀 + 64 位小写 hex
// （manifest-v1.schema.json 的 hash pattern）。
var sha256HashPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// ValidateManifest 校验 manifest 的必填字段与值域
// （manifest-v1.schema.json 的 required/const/enum/pattern）。
func ValidateManifest(manifest *Manifest) error {
	if manifest == nil {
		return errors.New("manifest is nil")
	}
	if manifest.ProtocolVersion != 1 {
		return fmt.Errorf("protocol_version must be 1, got %d", manifest.ProtocolVersion)
	}
	if manifest.DatasetID == "" {
		return errors.New("manifest requires dataset_id")
	}
	if manifest.Source == "" {
		return errors.New("manifest requires source")
	}
	if manifest.TenantID == "" {
		return errors.New("manifest requires tenant_id")
	}
	if len(manifest.Segments) == 0 {
		return errors.New("manifest requires at least one segment")
	}
	for i := range manifest.Segments {
		segment := &manifest.Segments[i]
		if segment.SegmentID == "" {
			return fmt.Errorf("segments[%d]: requires segment_id", i)
		}
		if len(segment.Ticks) == 0 {
			return fmt.Errorf("segments[%d]: requires non-empty ticks", i)
		}
		for _, tick := range segment.Ticks {
			if tick < 0 {
				return fmt.Errorf("segments[%d]: tick must be >= 0, got %d", i, tick)
			}
		}
	}
	for i := range manifest.Gaps {
		if manifest.Gaps[i].MissingCount < 0 {
			return fmt.Errorf("gaps[%d]: missing_count must be >= 0", i)
		}
	}
	for name, file := range manifest.Inputs {
		if !sha256HashPattern.MatchString(file.SHA256) {
			return fmt.Errorf("inputs[%s]: sha256 %q does not match ^sha256:[0-9a-f]{64}$", name, file.SHA256)
		}
		if file.Size < 0 {
			return fmt.Errorf("inputs[%s]: size must be >= 0", name)
		}
	}
	for i := range manifest.BadFiles {
		entry := &manifest.BadFiles[i]
		// 对象形态（manifest-v1.schema.json）要求非空 error；
		// 数字形态（legacy 实际数据）没有 error 字段，允许为空。
		if !entry.fromNumber && entry.Error == "" {
			return fmt.Errorf("bad_files[%d]: requires error", i)
		}
	}
	if !ValidMapMode(manifest.MapMode) {
		return fmt.Errorf("invalid map_mode %q", manifest.MapMode)
	}
	if !sha256HashPattern.MatchString(manifest.ConfigHash) {
		return fmt.Errorf("config_hash %q does not match ^sha256:[0-9a-f]{64}$", manifest.ConfigHash)
	}
	return nil
}

// ParseManifest 解析 manifest JSON：反序列化 + 全量校验。
func ParseManifest(data []byte) (*Manifest, error) {
	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, fmt.Errorf("parse manifest: %w", err)
	}
	if err := ValidateManifest(&manifest); err != nil {
		return nil, fmt.Errorf("invalid manifest: %w", err)
	}
	return &manifest, nil
}

// ParseManifestFile 读取并解析 manifest 文件。
func ParseManifestFile(path string) (*Manifest, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read manifest file %s: %w", path, err)
	}
	manifest, err := ParseManifest(data)
	if err != nil {
		return nil, fmt.Errorf("manifest file %s: %w", path, err)
	}
	return manifest, nil
}
