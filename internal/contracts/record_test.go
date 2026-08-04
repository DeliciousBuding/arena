package contracts

import (
	"strings"
	"testing"
)

// minimalRecordJSON 是通过校验的最小合法 record（对象/事件可为空数组）。
const minimalRecordJSON = `{"status":"ACTIVE","respawn_at_tick":null,"resources":0,"population":0,` +
	`"population_tier":0,"upkeep_next_tick":0,` +
	`"champion_beacon":{"position":[0,0],"status":null,"carrier_id":null},"objects":[],"events":[]}`

// TestParseDifferentialRecordInvalid 覆盖非法样例：错误枚举、缺必填、
// 类型错误、关系不变量违规（record-v1.schema.json 与 hero SDK 交叉验证）。
func TestParseDifferentialRecordInvalid(t *testing.T) {
	cases := []struct {
		name    string
		json    string
		wantErr string
	}{
		{name: "malformed json", json: `{`, wantErr: "parse differential record"},
		{name: "missing status", json: strings.Replace(minimalRecordJSON, `"status":"ACTIVE",`, "", 1), wantErr: "invalid status"},
		{name: "unknown status", json: strings.Replace(minimalRecordJSON, `"ACTIVE"`, `"DESTROYED"`, 1), wantErr: "invalid status"},
		{name: "active with respawn", json: strings.Replace(minimalRecordJSON, `"respawn_at_tick":null`, `"respawn_at_tick":5`, 1), wantErr: "ACTIVE state cannot contain"},
		{name: "respawning without respawn", json: strings.Replace(minimalRecordJSON, `"ACTIVE"`, `"RESPAWNING"`, 1), wantErr: "RESPAWNING state requires"},
		{name: "negative resources", json: strings.Replace(minimalRecordJSON, `"resources":0`, `"resources":-1`, 1), wantErr: "resources"},
		{name: "negative population", json: strings.Replace(minimalRecordJSON, `"population":0`, `"population":-1`, 1), wantErr: "population"},
		{name: "negative population_tier", json: strings.Replace(minimalRecordJSON, `"population_tier":0`, `"population_tier":-1`, 1), wantErr: "population_tier"},
		{name: "negative upkeep_next_tick", json: strings.Replace(minimalRecordJSON, `"upkeep_next_tick":0`, `"upkeep_next_tick":-1`, 1), wantErr: "upkeep_next_tick"},
		{name: "resources type error", json: strings.Replace(minimalRecordJSON, `"resources":0`, `"resources":"abc"`, 1), wantErr: "parse differential record"},
		{name: "objects type error", json: strings.Replace(minimalRecordJSON, `"objects":[]`, `"objects":{"a":1}`, 1), wantErr: "parse differential record"},
		{name: "beacon position wrong shape", json: strings.Replace(minimalRecordJSON, `[0,0]`, `[0]`, 1), wantErr: "parse differential record"},
		{name: "unknown beacon status", json: strings.Replace(minimalRecordJSON, `"status":null`, `"status":"LOST"`, 1), wantErr: "invalid beacon status"},
		{name: "carried without carrier", json: strings.Replace(minimalRecordJSON, `"status":null,"carrier_id":null`, `"status":"CARRIED","carrier_id":null`, 1), wantErr: "carrier_id is required"},
		{name: "ground with carrier", json: strings.Replace(minimalRecordJSON, `"status":null,"carrier_id":null`, `"status":"GROUND","carrier_id":"u1"`, 1), wantErr: "carrier_id is only valid"},

		{name: "unknown object kind", json: objectsJSON(`{"kind":"WALL","positions":[[0,0]]}`), wantErr: "unknown object kind"},
		{name: "obstacle without positions", json: objectsJSON(`{"kind":"OBSTACLE"}`), wantErr: "requires non-empty positions"},
		{name: "resource without positions", json: objectsJSON(`{"kind":"RESOURCE"}`), wantErr: "requires non-empty positions"},
		{name: "core missing id", json: objectsJSON(`{"kind":"CORE","controlled":true,"owner_username":"u","position":[0,0],"hp":5,"shield":5,"state":"NORMAL"}`), wantErr: "requires id"},
		{name: "core missing controlled", json: objectsJSON(`{"kind":"CORE","id":"c1","owner_username":"u","position":[0,0],"hp":5,"shield":5,"state":"NORMAL"}`), wantErr: "requires controlled"},
		{name: "core missing owner", json: objectsJSON(`{"kind":"CORE","id":"c1","controlled":true,"position":[0,0],"hp":5,"shield":5,"state":"NORMAL"}`), wantErr: "requires owner_username"},
		{name: "core missing position", json: objectsJSON(`{"kind":"CORE","id":"c1","controlled":true,"owner_username":"u","hp":5,"shield":5,"state":"NORMAL"}`), wantErr: "requires position"},
		{name: "core missing hp", json: objectsJSON(`{"kind":"CORE","id":"c1","controlled":true,"owner_username":"u","position":[0,0],"shield":5,"state":"NORMAL"}`), wantErr: "requires hp"},
		{name: "core missing shield", json: objectsJSON(`{"kind":"CORE","id":"c1","controlled":true,"owner_username":"u","position":[0,0],"hp":5,"state":"NORMAL"}`), wantErr: "requires shield"},
		{name: "core missing state", json: objectsJSON(`{"kind":"CORE","id":"c1","controlled":true,"owner_username":"u","position":[0,0],"hp":5,"shield":5}`), wantErr: "invalid CORE state"},
		{name: "core unknown state", json: objectsJSON(`{"kind":"CORE","id":"c1","controlled":true,"owner_username":"u","position":[0,0],"hp":5,"shield":5,"state":"FLYING"}`), wantErr: "invalid CORE state"},
		{name: "normal core with move_direction", json: objectsJSON(`{"kind":"CORE","id":"c1","controlled":true,"owner_username":"u","position":[0,0],"hp":5,"shield":5,"state":"NORMAL","move_direction":"UP"}`), wantErr: "NORMAL Core cannot contain"},
		{name: "moving core missing fields", json: objectsJSON(`{"kind":"CORE","id":"c1","controlled":true,"owner_username":"u","position":[0,0],"hp":5,"shield":5,"state":"MOVING"}`), wantErr: "MOVING Core requires"},
		{name: "unit missing id", json: objectsJSON(`{"kind":"UNIT","controlled":true,"position":[0,0],"hp":2,"unit_type":"WORKER"}`), wantErr: "requires id"},
		{name: "unit missing controlled", json: objectsJSON(`{"kind":"UNIT","id":"u1","position":[0,0],"hp":2,"unit_type":"WORKER"}`), wantErr: "requires controlled"},
		{name: "unit missing position", json: objectsJSON(`{"kind":"UNIT","id":"u1","controlled":true,"hp":2,"unit_type":"WORKER"}`), wantErr: "requires position"},
		{name: "unit missing hp", json: objectsJSON(`{"kind":"UNIT","id":"u1","controlled":true,"position":[0,0],"unit_type":"WORKER"}`), wantErr: "requires hp"},
		{name: "unit unknown unit_type", json: objectsJSON(`{"kind":"UNIT","id":"u1","controlled":true,"position":[0,0],"hp":2,"unit_type":"TANK"}`), wantErr: "invalid unit_type"},
		{name: "cargo on vanguard", json: objectsJSON(`{"kind":"UNIT","id":"u1","controlled":true,"position":[0,0],"hp":2,"unit_type":"VANGUARD","cargo":1}`), wantErr: "cargo is only valid"},
		{name: "cargo on enemy worker", json: objectsJSON(`{"kind":"UNIT","id":"u1","controlled":false,"position":[0,0],"hp":2,"unit_type":"WORKER","cargo":1}`), wantErr: "cargo is only valid"},
		{name: "unit negative hp", json: objectsJSON(`{"kind":"UNIT","id":"u1","controlled":true,"position":[0,0],"hp":-1,"unit_type":"WORKER"}`), wantErr: "hp"},

		{name: "event missing event_id", json: eventsJSON(`{"tick":1,"event_type":"X"}`), wantErr: "requires event_id"},
		{name: "event zero tick", json: eventsJSON(`{"event_id":"e1","tick":0,"event_type":"X"}`), wantErr: "tick must be >= 1"},
		{name: "event missing event_type", json: eventsJSON(`{"event_id":"e1","tick":1}`), wantErr: "requires event_type"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseDifferentialRecord([]byte(tc.json))
			if err == nil {
				t.Fatal("expected error, got nil")
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("error %q does not contain %q", err, tc.wantErr)
			}
		})
	}
}

// objectsJSON / eventsJSON 把单对象/单事件嵌入最小合法 record。
func objectsJSON(object string) string {
	return strings.Replace(minimalRecordJSON, `"objects":[]`, `"objects":[`+object+`]`, 1)
}

func eventsJSON(event string) string {
	return strings.Replace(minimalRecordJSON, `"events":[]`, `"events":[`+event+`]`, 1)
}

// TestValidateDifferentialRecordNil 覆盖 nil 入参。
func TestValidateDifferentialRecordNil(t *testing.T) {
	if err := ValidateDifferentialRecord(nil); err == nil {
		t.Error("ValidateDifferentialRecord(nil) must fail")
	}
	if err := ValidateChampionBeacon(nil); err == nil {
		t.Error("ValidateChampionBeacon(nil) must fail")
	}
	if err := ValidateObject(nil); err == nil {
		t.Error("ValidateObject(nil) must fail")
	}
	if err := ValidateEvent(nil); err == nil {
		t.Error("ValidateEvent(nil) must fail")
	}
}

// TestObjectKindEnum 固定对象 kind 全集（与 hero SDK WorldObject 判别并集一致）。
func TestObjectKindEnum(t *testing.T) {
	want := []ObjectKind{ObjectKindObstacle, ObjectKindCore, ObjectKindUnit, ObjectKindResource}
	got := KnownObjectKinds()
	if len(got) != len(want) {
		t.Fatalf("KnownObjectKinds() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("KnownObjectKinds() = %v, want %v", got, want)
		}
		if !ValidObjectKind(got[i]) {
			t.Errorf("ValidObjectKind(%q) = false", got[i])
		}
	}
	if ValidObjectKind("WALL") {
		t.Error("ValidObjectKind(WALL) must be false")
	}
}

// TestPlayerStatusCoreStateBeaconStatusEnums 固定 record 层其余枚举。
func TestPlayerStatusCoreStateBeaconStatusEnums(t *testing.T) {
	if !ValidPlayerStatus(PlayerStatusActive) || !ValidPlayerStatus(PlayerStatusRespawning) {
		t.Error("ValidPlayerStatus must accept ACTIVE/RESPAWNING")
	}
	if ValidPlayerStatus("DEAD") {
		t.Error("ValidPlayerStatus must reject unknown status")
	}
	if !ValidCoreState(CoreStateNormal) || !ValidCoreState(CoreStateMoving) {
		t.Error("ValidCoreState must accept NORMAL/MOVING")
	}
	if ValidCoreState("IDLE") {
		t.Error("ValidCoreState must reject unknown state")
	}
	if !ValidBeaconStatus(BeaconStatusGround) || !ValidBeaconStatus(BeaconStatusCarried) {
		t.Error("ValidBeaconStatus must accept GROUND/CARRIED")
	}
	if ValidBeaconStatus("LOST") {
		t.Error("ValidBeaconStatus must reject unknown status")
	}
}

// TestMapModeEnum 固定 map_mode 枚举（manifest-v1.schema.json）。
func TestMapModeEnum(t *testing.T) {
	for _, mode := range []MapMode{MapModeDisabled, MapModeFrozen, MapModeControlled} {
		if !ValidMapMode(mode) {
			t.Errorf("ValidMapMode(%q) = false", mode)
		}
	}
	if ValidMapMode("wild") {
		t.Error("ValidMapMode must reject unknown mode")
	}
}

// validManifestJSON 是通过校验的最小合法 manifest。
const validManifestJSON = `{"protocol_version":1,"dataset_id":"d","source":"s","tenant_id":"t",` +
	`"segments":[{"segment_id":"s1","ticks":[1,2]}],"gaps":[],` +
	`"inputs":{"1":{"sha256":"sha256:0000000000000000000000000000000000000000000000000000000000000000","size":10}},` +
	`"map_mode":"disabled","decision_config":{},"config_hash":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}`

// TestParseManifestInvalid 覆盖 manifest 非法样例（manifest-v1.schema.json
// 的 required/const/enum/pattern）。
func TestParseManifestInvalid(t *testing.T) {
	cases := []struct {
		name    string
		json    string
		wantErr string
	}{
		{name: "malformed json", json: `[`, wantErr: "parse manifest"},
		{name: "wrong protocol version", json: strings.Replace(validManifestJSON, `"protocol_version":1`, `"protocol_version":2`, 1), wantErr: "protocol_version"},
		{name: "missing dataset_id", json: strings.Replace(validManifestJSON, `"dataset_id":"d",`, "", 1), wantErr: "dataset_id"},
		{name: "missing source", json: strings.Replace(validManifestJSON, `"source":"s",`, "", 1), wantErr: "source"},
		{name: "missing tenant_id", json: strings.Replace(validManifestJSON, `"tenant_id":"t",`, "", 1), wantErr: "tenant_id"},
		{name: "missing segments", json: strings.Replace(validManifestJSON, `"segments":[{"segment_id":"s1","ticks":[1,2]}],`, "", 1), wantErr: "at least one segment"},
		{name: "empty segment ticks", json: strings.Replace(validManifestJSON, `"ticks":[1,2]`, `"ticks":[]`, 1), wantErr: "non-empty ticks"},
		{name: "segment missing id", json: strings.Replace(validManifestJSON, `"segment_id":"s1"`, `"segment_id":""`, 1), wantErr: "segment_id"},
		{name: "negative segment tick", json: strings.Replace(validManifestJSON, `"ticks":[1,2]`, `"ticks":[-1]`, 1), wantErr: "tick must be >= 0"},
		{name: "negative gap count", json: strings.Replace(validManifestJSON, `"gaps":[]`, `"gaps":[{"after":1,"before":3,"missing_count":-1}]`, 1), wantErr: "missing_count"},
		{name: "input sha256 bad pattern", json: strings.Replace(validManifestJSON, "0000000000000000000000000000000000000000000000000000000000000000", "zzzz", 1), wantErr: "sha256"},
		{name: "input negative size", json: strings.Replace(validManifestJSON, `"size":10`, `"size":-1`, 1), wantErr: "size"},
		{name: "bad file without error", json: strings.Replace(validManifestJSON, `"decision_config":{}`, `"decision_config":{},"bad_files":[{"tick":1,"error":""}]`, 1), wantErr: "bad_files"},
		{name: "unknown map_mode", json: strings.Replace(validManifestJSON, `"disabled"`, `"wild"`, 1), wantErr: "invalid map_mode"},
		{name: "bad config_hash", json: strings.Replace(validManifestJSON, `"config_hash":"sha256:0000000000000000000000000000000000000000000000000000000000000000"`, `"config_hash":"nope"`, 1), wantErr: "config_hash"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseManifest([]byte(tc.json))
			if err == nil {
				t.Fatal("expected error, got nil")
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("error %q does not contain %q", err, tc.wantErr)
			}
		})
	}
}

// TestParseManifestValid 验证最小合法 manifest 通过校验。
func TestParseManifestValid(t *testing.T) {
	manifest, err := ParseManifest([]byte(validManifestJSON))
	if err != nil {
		t.Fatalf("ParseManifest: %v", err)
	}
	if manifest.DatasetID != "d" || len(manifest.Segments) != 1 || len(manifest.Inputs) != 1 {
		t.Errorf("unexpected manifest: %+v", manifest)
	}
}

// TestValidateManifestNil 覆盖 nil 入参。
func TestValidateManifestNil(t *testing.T) {
	if err := ValidateManifest(nil); err == nil {
		t.Error("ValidateManifest(nil) must fail")
	}
}

// TestEventValuesFreeForm 验证事件 values 为自由对象（不设枚举，
// hero SDK ResolutionEvent.values 为 Record<string, any>）。
func TestEventValuesFreeForm(t *testing.T) {
	json := eventsJSON(`{"event_id":"e1","tick":1,"event_type":"UNIT_DAMAGED","values":{"damage":2,"hp":0,"custom":true}}`)
	record, err := ParseDifferentialRecord([]byte(json))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	values := record.Events[0].Values
	if len(values) != 3 || values["damage"] != float64(2) || values["hp"] != float64(0) || values["custom"] != true {
		t.Errorf("values = %v", values)
	}
}
