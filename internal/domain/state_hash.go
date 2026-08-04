package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

// HashState 计算 TickState 的 canonical sha256 内容哈希（与 TS 版
// integrity.ts sha256Canonical 同语义）：
//   - 对象键排序（canonical JSON，无空白、无换行）；
//   - 数值稳定序列化（整数 %d，整值浮点归一为整数，其余 'g' 格式）；
//   - 字段顺序无关：无论状态以何种构造顺序构建，等值即等哈希；
//   - StateHash 字段本身不参与哈希（避免自引用）。
//
// 不依赖 encoding/json（docs/go/02-contracts.md §1.3：领域层经
// contracts 转换，wire 解耦）。
func HashState(state *TickState) string {
	var builder strings.Builder
	writeCanonicalValue(&builder, stateToCanonical(state))
	sum := sha256.Sum256([]byte(builder.String()))
	return hex.EncodeToString(sum[:])
}

// stateToCanonical 把 TickState 转为 canonical 树：对象键固定、切片保持
// 顺序、集合转排序数组（与 TS 版 TickState 语义一致）。
func stateToCanonical(state *TickState) map[string]any {
	return map[string]any{
		"tick":              state.Tick,
		"status":            string(state.Status),
		"resources":         state.Resources,
		"resource_capacity": state.ResourceCapacity,
		"resource_space":    state.ResourceSpace,
		"population":        state.Population,
		"population_tier":   state.PopulationTier,
		"upkeep_next_tick":  state.UpkeepNextTick,
		"core":              coreToCanonical(state.Core),
		"units":             unitsToCanonical(state.Units),
		"workers":           unitsToCanonical(state.Workers),
		"vanguards":         unitsToCanonical(state.Vanguards),
		"rangers":           unitsToCanonical(state.Rangers),
		"visible_enemies":   enemiesToCanonical(state.VisibleEnemies),
		"resource_cells":    cellsToCanonical(state.ResourceCells),
		"obstacle_cells":    cellsToCanonical(state.ObstacleCells),
		"beacon": map[string]any{
			"position":   positionToCanonical(state.Beacon.Position),
			"status":     string(state.Beacon.Status),
			"carrier_id": nullableString(state.Beacon.CarrierID),
		},
		"events": eventsToCanonical(state.Events),
	}
}

// writeCanonicalValue 写 canonical JSON 值：对象键排序、数组保持顺序、
// 字符串最小转义；不支持的 Go 类型视为编程错误（panic）。
func writeCanonicalValue(builder *strings.Builder, value any) {
	switch v := value.(type) {
	case nil:
		builder.WriteString("null")
	case bool:
		if v {
			builder.WriteString("true")
		} else {
			builder.WriteString("false")
		}
	case int:
		builder.WriteString(strconv.Itoa(v))
	case float64:
		builder.WriteString(formatCanonicalFloat(v))
	case string:
		writeCanonicalString(builder, v)
	case []any:
		builder.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				builder.WriteByte(',')
			}
			writeCanonicalValue(builder, item)
		}
		builder.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		builder.WriteByte('{')
		for i, key := range keys {
			if i > 0 {
				builder.WriteByte(',')
			}
			writeCanonicalString(builder, key)
			builder.WriteByte(':')
			writeCanonicalValue(builder, v[key])
		}
		builder.WriteByte('}')
	default:
		panic(fmt.Sprintf("canonical JSON: unsupported value type %T", value))
	}
}

// formatCanonicalFloat 以确定性格式输出浮点：整值且在 int64 精确范围内
// 输出整数字面量（与 TS 版 JSON.stringify 对整值 JSON 数字的语义一致）。
func formatCanonicalFloat(value float64) string {
	if value == math.Trunc(value) && math.Abs(value) < 1<<53 {
		return strconv.FormatInt(int64(value), 10)
	}
	return strconv.FormatFloat(value, 'g', -1, 64)
}

// writeCanonicalString 输出 JSON 字符串（最小转义：引号/反斜杠/控制字符）。
func writeCanonicalString(builder *strings.Builder, value string) {
	builder.WriteByte('"')
	for _, r := range value {
		switch r {
		case '"':
			builder.WriteString(`\"`)
		case '\\':
			builder.WriteString(`\\`)
		case '\n':
			builder.WriteString(`\n`)
		case '\r':
			builder.WriteString(`\r`)
		case '\t':
			builder.WriteString(`\t`)
		case '\b':
			builder.WriteString(`\b`)
		case '\f':
			builder.WriteString(`\f`)
		default:
			if r < 0x20 {
				builder.WriteString(fmt.Sprintf(`\u%04X`, r))
			} else {
				builder.WriteRune(r)
			}
		}
	}
	builder.WriteByte('"')
}

func nullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func positionToCanonical(position Position) []any {
	return []any{position[0], position[1]}
}

func cellsToCanonical(cells Set[string]) []any {
	keys := make([]string, 0, cells.Len())
	for cell := range cells {
		keys = append(keys, cell)
	}
	sort.Strings(keys)
	result := make([]any, 0, len(keys))
	for _, key := range keys {
		position, err := ParseCellKey(key)
		if err != nil {
			continue
		}
		result = append(result, positionToCanonical(position))
	}
	return result
}

func unitsToCanonical(units []UnitSnapshot) []any {
	result := make([]any, 0, len(units))
	for _, unit := range units {
		result = append(result, map[string]any{
			"id":        unit.ID,
			"position":  positionToCanonical(unit.Position),
			"hp":        unit.HP,
			"unit_type": string(unit.UnitType),
			"cargo":     unit.Cargo,
		})
	}
	return result
}

func enemiesToCanonical(enemies []VisibleEntity) []any {
	result := make([]any, 0, len(enemies))
	for _, enemy := range enemies {
		entry := map[string]any{
			"id":       enemy.ID,
			"kind":     enemy.Kind,
			"position": positionToCanonical(enemy.Position),
			"hp":       enemy.HP,
		}
		if enemy.UnitType != nil {
			entry["unit_type"] = string(*enemy.UnitType)
		}
		if enemy.OwnerUsername != nil {
			entry["owner_username"] = *enemy.OwnerUsername
		}
		result = append(result, entry)
	}
	return result
}

func coreToCanonical(core *Core) any {
	if core == nil {
		return nil
	}
	return map[string]any{
		"id":             core.ID,
		"position":       positionToCanonical(core.Position),
		"hp":             core.HP,
		"shield":         core.Shield,
		"state":          string(core.State),
		"owner_username": core.OwnerUsername,
	}
}

func eventsToCanonical(events []Event) []any {
	result := make([]any, 0, len(events))
	for _, event := range events {
		entry := map[string]any{
			"event_id":   event.EventID,
			"tick":       event.Tick,
			"event_type": event.EventType,
		}
		if event.ReasonCode != nil {
			entry["reason_code"] = *event.ReasonCode
		}
		if event.ActorID != nil {
			entry["actor_id"] = *event.ActorID
		}
		if event.TargetID != nil {
			entry["target_id"] = *event.TargetID
		}
		if event.Position != nil {
			entry["position"] = positionToCanonical(*event.Position)
		}
		if event.Values != nil {
			entry["values"] = event.Values
		}
		result = append(result, entry)
	}
	return result
}
