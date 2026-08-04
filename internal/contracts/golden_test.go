package contracts

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// fixtureDir 指向差分回放 fixture（相对本包目录，go test 的 working dir
// 即包目录）。fixture 只读，测试只消费不修改。
const fixtureDir = "../../fixtures/differential/burnin-20260802-a"

func fixturePath(name string) string {
	return filepath.Join(fixtureDir, name)
}

// TestParseRealFixture40437 从真实 fixture 读取单 tick 记录并逐字段断言
// （期望值来自 40437.json 实际内容，与 02-contracts.md §3 的
// DifferentialRecord 布局一致）。
func TestParseRealFixture40437(t *testing.T) {
	data, err := os.ReadFile(fixturePath("40437.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	record, err := ParseDifferentialRecord(data)
	if err != nil {
		t.Fatalf("ParseDifferentialRecord: %v", err)
	}

	if record.Status != PlayerStatusActive {
		t.Errorf("status = %q, want %q", record.Status, PlayerStatusActive)
	}
	if record.RespawnAtTick != nil {
		t.Errorf("respawn_at_tick = %v, want nil", *record.RespawnAtTick)
	}
	if record.Resources != 1 {
		t.Errorf("resources = %d, want 1", record.Resources)
	}
	if record.Population != 3 {
		t.Errorf("population = %d, want 3", record.Population)
	}
	if record.PopulationTier != 0 {
		t.Errorf("population_tier = %d, want 0", record.PopulationTier)
	}
	if record.UpkeepNextTick != 0 {
		t.Errorf("upkeep_next_tick = %d, want 0", record.UpkeepNextTick)
	}

	beacon := record.ChampionBeacon
	if beacon.Position != (Position{-17, 77}) {
		t.Errorf("beacon position = %v, want [-17 77]", beacon.Position)
	}
	if beacon.Status != nil {
		t.Errorf("beacon status = %v, want nil", *beacon.Status)
	}
	if beacon.CarrierID != nil {
		t.Errorf("beacon carrier_id = %v, want nil", *beacon.CarrierID)
	}

	if len(record.Objects) != 5 {
		t.Fatalf("objects = %d, want 5", len(record.Objects))
	}

	obstacle := record.Objects[0]
	if obstacle.Kind != ObjectKindObstacle {
		t.Errorf("objects[0].kind = %q, want OBSTACLE", obstacle.Kind)
	}
	if len(obstacle.Positions) != 10 {
		t.Errorf("objects[0].positions = %d cells, want 10", len(obstacle.Positions))
	}
	if obstacle.Positions[0] != (Position{17, -86}) {
		t.Errorf("objects[0].positions[0] = %v, want [17 -86]", obstacle.Positions[0])
	}
	if obstacle.Positions[9] != (Position{24, -98}) {
		t.Errorf("objects[0].positions[9] = %v, want [24 -98]", obstacle.Positions[9])
	}

	core := record.Objects[1]
	if core.Kind != ObjectKindCore {
		t.Errorf("objects[1].kind = %q, want CORE", core.Kind)
	}
	if core.ID != "d2d5a983-d24d-4763-a01a-9a658bc35010" {
		t.Errorf("core id = %q", core.ID)
	}
	if core.Controlled == nil || !*core.Controlled {
		t.Errorf("core controlled = %v, want true", core.Controlled)
	}
	if core.OwnerUsername != "fixture_user" {
		t.Errorf("core owner_username = %q, want fixture_user", core.OwnerUsername)
	}
	if core.Position == nil || *core.Position != (Position{20, -97}) {
		t.Errorf("core position = %v, want [20 -97]", core.Position)
	}
	if core.HP == nil || *core.HP != 5 {
		t.Errorf("core hp = %v, want 5", core.HP)
	}
	if core.Shield == nil || *core.Shield != 5 {
		t.Errorf("core shield = %v, want 5", core.Shield)
	}
	if core.State != string(CoreStateNormal) {
		t.Errorf("core state = %q, want NORMAL", core.State)
	}
	if core.MoveDirection != nil || core.MoveProgress != nil ||
		core.MoveRequiredTicks != nil || core.Destination != nil {
		t.Errorf("NORMAL core must have nil movement fields, got %v/%v/%v/%v",
			core.MoveDirection, core.MoveProgress, core.MoveRequiredTicks, core.Destination)
	}

	unit1 := record.Objects[2]
	if unit1.Kind != ObjectKindUnit || unit1.ID != "312e4dbf-d356-49ef-b599-691ef3f7c9e8" {
		t.Errorf("objects[2] = kind %q id %q, want UNIT 312e4dbf-…", unit1.Kind, unit1.ID)
	}
	if unit1.Position == nil || *unit1.Position != (Position{20, -86}) {
		t.Errorf("objects[2] position = %v, want [20 -86]", unit1.Position)
	}
	if unit1.HP == nil || *unit1.HP != 2 {
		t.Errorf("objects[2] hp = %v, want 2", unit1.HP)
	}
	if unit1.UnitType != string(UnitTypeWorker) {
		t.Errorf("objects[2] unit_type = %q, want WORKER", unit1.UnitType)
	}
	if unit1.Cargo == nil || *unit1.Cargo != 1 {
		t.Errorf("objects[2] cargo = %v, want 1", unit1.Cargo)
	}
	unit2 := record.Objects[3]
	if unit2.ID != "9c8ee7d0-f25c-420f-9ed7-c4997540a14b" ||
		unit2.Position == nil || *unit2.Position != (Position{20, -101}) ||
		unit2.Cargo == nil || *unit2.Cargo != 0 {
		t.Errorf("objects[3] = id %q position %v cargo %v", unit2.ID, unit2.Position, unit2.Cargo)
	}
	unit3 := record.Objects[4]
	if unit3.ID != "b1db4ce5-08df-485f-a5d6-2a8982621a9c" ||
		unit3.Position == nil || *unit3.Position != (Position{20, -101}) ||
		unit3.Cargo == nil || *unit3.Cargo != 0 {
		t.Errorf("objects[4] = id %q position %v cargo %v", unit3.ID, unit3.Position, unit3.Cargo)
	}

	if len(record.Events) != 3 {
		t.Fatalf("events = %d, want 3", len(record.Events))
	}
	eventIDs := []string{
		"419de2eb-4e97-4053-8282-f2eae03cec3a",
		"70226e84-62ba-402d-ae82-405fc37b1eb7",
		"750b80f5-b42c-481d-86c8-bcba25721083",
	}
	for i, wantID := range eventIDs {
		event := record.Events[i]
		if event.EventID != wantID {
			t.Errorf("events[%d].event_id = %q, want %q", i, event.EventID, wantID)
		}
		if event.Tick != 40436 {
			t.Errorf("events[%d].tick = %d, want 40436", i, event.Tick)
		}
		if event.EventType != "UNIT_MOVE_SUCCEEDED" {
			t.Errorf("events[%d].event_type = %q, want UNIT_MOVE_SUCCEEDED", i, event.EventType)
		}
		if event.ReasonCode != nil || event.TargetID != nil || event.Values != nil {
			t.Errorf("events[%d] must have nil reason_code/target_id/values", i)
		}
	}
	if record.Events[0].ActorID == nil || *record.Events[0].ActorID != "312e4dbf-d356-49ef-b599-691ef3f7c9e8" {
		t.Errorf("events[0].actor_id = %v, want 312e4dbf-…", record.Events[0].ActorID)
	}
	if record.Events[0].Position == nil || *record.Events[0].Position != (Position{20, -86}) {
		t.Errorf("events[0].position = %v, want [20 -86]", record.Events[0].Position)
	}
}

// TestParseRecordFile40437 验证 ParseRecordFile 走文件路径解析真实 fixture。
func TestParseRecordFile40437(t *testing.T) {
	record, err := ParseRecordFile(fixturePath("40437.json"))
	if err != nil {
		t.Fatalf("ParseRecordFile: %v", err)
	}
	if record.Population != 3 || len(record.Objects) != 5 || len(record.Events) != 3 {
		t.Errorf("unexpected record: population %d objects %d events %d",
			record.Population, len(record.Objects), len(record.Events))
	}
}

// TestParseRecordFileMissing 验证不存在的文件路径报错。
func TestParseRecordFileMissing(t *testing.T) {
	if _, err := ParseRecordFile(fixturePath("no-such-file.json")); err == nil {
		t.Fatal("ParseRecordFile on missing file must fail")
	}
}

// TestAllFixtureRecordsParse 全量回放 100 个真实 fixture 记录并断言数据集
// 不变量（对象 kind 分布、事件总数、状态分布来自数据集扫描结果）。
func TestAllFixtureRecordsParse(t *testing.T) {
	matches, err := filepath.Glob(filepath.Join(fixtureDir, "*.json"))
	if err != nil {
		t.Fatalf("glob fixtures: %v", err)
	}
	var records []string
	for _, match := range matches {
		if filepath.Base(match) == "manifest.json" {
			continue
		}
		records = append(records, match)
	}
	if len(records) != 100 {
		t.Fatalf("record files = %d, want 100", len(records))
	}

	kindCounts := map[ObjectKind]int{}
	eventCount := 0
	enemyUnits := 0
	unitTypes := map[string]int{}
	for _, path := range records {
		record, err := ParseRecordFile(path)
		if err != nil {
			t.Fatalf("parse %s: %v", filepath.Base(path), err)
		}
		if record.Status != PlayerStatusActive {
			t.Errorf("%s: status = %q, want ACTIVE", filepath.Base(path), record.Status)
		}
		if record.RespawnAtTick != nil {
			t.Errorf("%s: respawn_at_tick must be nil in this dataset", filepath.Base(path))
		}
		if record.ChampionBeacon.CarrierID != nil {
			t.Errorf("%s: beacon carrier_id must be nil in this dataset", filepath.Base(path))
		}
		for i := range record.Objects {
			object := &record.Objects[i]
			kindCounts[object.Kind]++
			if object.Kind == ObjectKindUnit {
				unitTypes[object.UnitType]++
				if object.Controlled != nil && !*object.Controlled {
					enemyUnits++
				}
			}
		}
		eventCount += len(record.Events)
	}
	if kindCounts[ObjectKindCore] != 100 || kindCounts[ObjectKindObstacle] != 100 ||
		kindCounts[ObjectKindUnit] != 333 || kindCounts[ObjectKindResource] != 57 {
		t.Errorf("object kind distribution = %v, want CORE 100 / OBSTACLE 100 / UNIT 333 / RESOURCE 57", kindCounts)
	}
	if eventCount != 335 {
		t.Errorf("total events = %d, want 335", eventCount)
	}
	if enemyUnits != 16 {
		t.Errorf("enemy (controlled=false) units = %d, want 16", enemyUnits)
	}
	if unitTypes[string(UnitTypeWorker)] != 319 || unitTypes[string(UnitTypeVanguard)] != 14 {
		t.Errorf("unit type distribution = %v, want WORKER 319 / VANGUARD 14", unitTypes)
	}
}

// TestDifferentialRecordSemanticRoundTrip 验证 record 语义往返稳定：
// parse → marshal → parse 得到相等结构（omitempty 丢弃 null 后依旧相等）。
func TestDifferentialRecordSemanticRoundTrip(t *testing.T) {
	data, err := os.ReadFile(fixturePath("40437.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	first, err := ParseDifferentialRecord(data)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	marshaled, err := json.Marshal(first)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	second, err := ParseDifferentialRecord(marshaled)
	if err != nil {
		t.Fatalf("re-parse marshaled record: %v", err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Errorf("semantic round trip mismatch:\nfirst:  %+v\nsecond: %+v", first, second)
	}
}

// TestParseRealManifest 从真实 fixture manifest 逐字段断言
// （期望值来自 manifest.json 实际内容，字段布局与 manifest-v1.schema.json
// 一致：protocol_version=1、map_mode=disabled、decision_config 单源注入）。
func TestParseRealManifest(t *testing.T) {
	manifest, err := ParseManifestFile(fixturePath("manifest.json"))
	if err != nil {
		t.Fatalf("ParseManifestFile: %v", err)
	}
	if manifest.ProtocolVersion != 1 {
		t.Errorf("protocol_version = %d, want 1", manifest.ProtocolVersion)
	}
	if manifest.DatasetID != "burnin-20260802-a" {
		t.Errorf("dataset_id = %q", manifest.DatasetID)
	}
	if manifest.Source != "runs/run-20260802T133504-7b42dd/raw-state" {
		t.Errorf("source = %q", manifest.Source)
	}
	if manifest.TenantID != "unknown" {
		t.Errorf("tenant_id = %q", manifest.TenantID)
	}
	if manifest.MapMode != MapModeDisabled {
		t.Errorf("map_mode = %q, want disabled", manifest.MapMode)
	}
	if manifest.ConfigHash != "sha256:824423f1fb992469a2fba72c764c31eaee3170adcc18132eb8fa32b3dcaca71e" {
		t.Errorf("config_hash = %q", manifest.ConfigHash)
	}
	if len(manifest.Segments) != 1 {
		t.Fatalf("segments = %d, want 1", len(manifest.Segments))
	}
	segment := manifest.Segments[0]
	if segment.SegmentID != "unknown-001" {
		t.Errorf("segment_id = %q, want unknown-001", segment.SegmentID)
	}
	if len(segment.Ticks) != 100 || segment.Ticks[0] != 40437 || segment.Ticks[99] != 40536 {
		t.Errorf("segment ticks = %d entries, first %d last %d; want 100, 40437, 40536",
			len(segment.Ticks), segment.Ticks[0], segment.Ticks[len(segment.Ticks)-1])
	}
	if len(manifest.Gaps) != 0 {
		t.Errorf("gaps = %d, want 0", len(manifest.Gaps))
	}
	if len(manifest.Inputs) != 100 {
		t.Errorf("inputs = %d, want 100", len(manifest.Inputs))
	}
	firstInput, ok := manifest.Inputs["40437"]
	if !ok {
		t.Fatal("inputs[40437] missing")
	}
	if firstInput.SHA256 != "sha256:6f3f230398cc0bc20ea03de78752bc40c3c3fcbb4a7e8dd092f838f9de6122a8" {
		t.Errorf("inputs[40437].sha256 = %q", firstInput.SHA256)
	}
	if firstInput.Size != 1824 {
		t.Errorf("inputs[40437].size = %d, want 1824", firstInput.Size)
	}
	if len(manifest.BadFiles) != 47 {
		t.Errorf("bad_files = %d, want 47", len(manifest.BadFiles))
	}
	wantConfig := map[string]any{
		"worker_target":      float64(8),
		"population_ceiling": float64(20),
		"explore_radius":     float64(8),
		"guard_resources":    float64(30),
		"guard_force":        float64(4),
	}
	if !reflect.DeepEqual(manifest.DecisionConfig, wantConfig) {
		t.Errorf("decision_config = %v, want %v", manifest.DecisionConfig, wantConfig)
	}
}

// TestManifestSemanticRoundTrip 验证 manifest 语义往返稳定。
func TestManifestSemanticRoundTrip(t *testing.T) {
	first, err := ParseManifestFile(fixturePath("manifest.json"))
	if err != nil {
		t.Fatalf("parse manifest: %v", err)
	}
	marshaled, err := json.Marshal(first)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	second, err := ParseManifest(marshaled)
	if err != nil {
		t.Fatalf("re-parse marshaled manifest: %v", err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Errorf("manifest semantic round trip mismatch:\nfirst:  %+v\nsecond: %+v", first, second)
	}
}

// TestLooseFieldTolerance 固定"宽松字段"语义：未知顶层字段与对象附加字段
// 不阻断解析（02-contracts.md §4 前向兼容约定），未知枚举仍拒绝。
func TestLooseFieldTolerance(t *testing.T) {
	base := `{"status":"ACTIVE","resources":0,"population":0,"population_tier":0,"upkeep_next_tick":0,` +
		`"champion_beacon":{"position":[0,0],"status":null,"carrier_id":null},"objects":[],"events":[]}`
	withUnknownTopLevel := strings.Replace(base, `{"status"`, `{"future_field":{"a":1},"status"`, 1)
	if _, err := ParseDifferentialRecord([]byte(withUnknownTopLevel)); err != nil {
		t.Errorf("unknown top-level field must be tolerated, got: %v", err)
	}
	withUnknownObjectField := strings.Replace(base, `"objects":[]`,
		`"objects":[{"kind":"CORE","id":"c1","controlled":true,"owner_username":"u","position":[0,0],`+
			`"hp":5,"shield":5,"state":"NORMAL","future_object_field":"x"}]`, 1)
	if _, err := ParseDifferentialRecord([]byte(withUnknownObjectField)); err != nil {
		t.Errorf("unknown object field must be tolerated, got: %v", err)
	}
	unknownEnum := strings.Replace(base, `"status":"ACTIVE"`, `"status":"DESTROYED"`, 1)
	if _, err := ParseDifferentialRecord([]byte(unknownEnum)); err == nil {
		t.Error("unknown enum value must be rejected")
	}
}
