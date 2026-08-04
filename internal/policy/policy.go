// Package policy 实现低频 MacroPolicy 战略参数：类型定义、值域校验、
// 规范化、确定性序列化与模型输出解析（阶段 D 前置，不含编排与 prompt）。
//
// 解析语义对齐 TS 版 parsePolicyText：剥 markdown 围栏 → 提取首个 JSON 对象
// → 校验 → 规范化；但值域以 03-module-spec.md M8 为准（posture 三值、
// workerTarget ∈ [0,20]、militaryRatio ∈ [0,1]、focusRegion 坐标 ∈ [-1000,1000]），
// 与 TS 版值域（harvest/balanced/aggressive、workerTarget ≥ 1）不同。
package policy

import (
	"encoding/json"
	"fmt"
	"strings"
)

// 战略姿态（posture）枚举：决定执行层 aggression 映射与生产优先级。
const (
	PostureAggressive = "aggressive"
	PostureBalanced   = "balanced"
	PostureDefensive  = "defensive"
)

// 值域边界（校验与规范化共用）。
const (
	WorkerTargetMin = 0
	WorkerTargetMax = 20

	// FocusRegionMin/FocusRegionMax 是重点区域坐标的边界（含端点）。
	FocusRegionMin = -1000
	FocusRegionMax = 1000
)

// MacroPolicy 是低频宏观战略参数（LLM 输出经 ParsePolicyText 解析得到）。
// 字段声明序即规范序列化键序（posture → workerTarget → militaryRatio →
// focusRegion → attackTarget），由 struct 定义保证稳定；focusRegion /
// attackTarget 为空时序列化省略（omitempty）。
type MacroPolicy struct {
	Posture       string  `json:"posture"`                // "aggressive" | "balanced" | "defensive"
	WorkerTarget  int     `json:"workerTarget"`           // 经济目标：目标 worker 数（0-20）
	MilitaryRatio float64 `json:"militaryRatio"`          // 军事占比（0.0-1.0）
	FocusRegion   *[2]int `json:"focusRegion,omitempty"`  // 可选：重点区域坐标
	AttackTarget  string  `json:"attackTarget,omitempty"` // 可选：攻击目标
}

// Default 返回默认策略：均衡姿态、5 个目标 worker、30% 军事占比
// （经济优先的保守兜底语义）。
func Default() MacroPolicy {
	return MacroPolicy{
		Posture:       PostureBalanced,
		WorkerTarget:  5,
		MilitaryRatio: 0.3,
	}
}

// Validate 校验策略值域：posture 必须三值之一、workerTarget ∈ [0,20]、
// militaryRatio ∈ [0,1]、focusRegion 坐标 ∈ [-1000,1000]（为 nil 时跳过）。
func Validate(p MacroPolicy) error {
	switch p.Posture {
	case PostureAggressive, PostureBalanced, PostureDefensive:
	default:
		return fmt.Errorf("invalid posture %q (must be aggressive/balanced/defensive)", p.Posture)
	}
	if p.WorkerTarget < WorkerTargetMin || p.WorkerTarget > WorkerTargetMax {
		return fmt.Errorf("workerTarget %d out of range [%d, %d]", p.WorkerTarget, WorkerTargetMin, WorkerTargetMax)
	}
	if p.MilitaryRatio < 0 || p.MilitaryRatio > 1 {
		return fmt.Errorf("militaryRatio %v out of range [0, 1]", p.MilitaryRatio)
	}
	if p.FocusRegion != nil {
		for i, coordinate := range p.FocusRegion {
			if coordinate < FocusRegionMin || coordinate > FocusRegionMax {
				return fmt.Errorf("focusRegion[%d] %d out of range [%d, %d]", i, coordinate, FocusRegionMin, FocusRegionMax)
			}
		}
	}
	return nil
}

// Normalize 规范化策略：workerTarget/militaryRatio 越界 clamp 回值域、
// 未知 posture 回落 balanced；focusRegion/attackTarget 保持原样（值域内
// 输入为恒等变换，供解析后与手写输入统一使用）。
func Normalize(p MacroPolicy) MacroPolicy {
	if p.Posture != PostureAggressive && p.Posture != PostureDefensive {
		p.Posture = PostureBalanced
	}
	if p.WorkerTarget < WorkerTargetMin {
		p.WorkerTarget = WorkerTargetMin
	} else if p.WorkerTarget > WorkerTargetMax {
		p.WorkerTarget = WorkerTargetMax
	}
	if p.MilitaryRatio < 0 {
		p.MilitaryRatio = 0
	} else if p.MilitaryRatio > 1 {
		p.MilitaryRatio = 1
	}
	return p
}

// Serialize 确定性序列化：紧凑 JSON，键序由 struct 字段序固定，
// 同值两次序列化字节一致。
func Serialize(p MacroPolicy) ([]byte, error) {
	data, err := json.Marshal(p)
	if err != nil {
		return nil, fmt.Errorf("serialize macro policy: %w", err)
	}
	return data, nil
}

// ParsePolicyText 解析模型策略输出：剥 markdown 围栏（```json、```、```JSON
// 变体与尾部 ```）→ 提取首个 {...} 块 → Unmarshal → Validate。
// 未知字段被忽略（与 TS 版 normalize 的"未知字段剔除"语义一致）；
// 任何失败返回带原文摘要的错误（摘要折叠空白并截断至 200 字符）。
func ParsePolicyText(text string) (MacroPolicy, error) {
	body := stripMarkdownFences(text)
	jsonStart, jsonEnd := findJSONObject(body)
	if jsonStart == -1 {
		// 同行围栏（```json {...}```）等畸形场景：退回到原文提取，
		// 与 TS 版"首 { / 尾 }"语义一致。
		body = text
		jsonStart, jsonEnd = findJSONObject(body)
	}
	if jsonStart == -1 {
		return MacroPolicy{}, fmt.Errorf("parse macro policy: no JSON object in model output (text: %q)", summarize(text))
	}
	var p MacroPolicy
	if err := json.Unmarshal([]byte(body[jsonStart:jsonEnd+1]), &p); err != nil {
		return MacroPolicy{}, fmt.Errorf("parse macro policy: invalid JSON: %v (text: %q)", err, summarize(text))
	}
	if err := Validate(p); err != nil {
		return MacroPolicy{}, fmt.Errorf("parse macro policy: %w (text: %q)", err, summarize(text))
	}
	return p, nil
}

// stripMarkdownFences 剥掉 markdown 围栏：开围栏 ``` 可带语言标签
// （json/JSON/jsonc 等），尾围栏为独立的 ``` 行；无围栏时原样返回。
// 只有围栏无内容时返回空串（由调用方报"无 JSON 对象"错误）。
func stripMarkdownFences(text string) string {
	body := strings.TrimSpace(text)
	if !strings.HasPrefix(body, "```") {
		return body
	}
	lines := strings.Split(body, "\n")
	lines = lines[1:] // 丢弃开围栏行
	if len(lines) > 0 && strings.HasPrefix(strings.TrimSpace(lines[len(lines)-1]), "```") {
		lines = lines[:len(lines)-1] // 丢弃尾围栏行
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

// findJSONObject 返回首个 { 与末个 } 的位置；不存在完整 {...} 块时
// 返回 (-1, -1)。
func findJSONObject(body string) (int, int) {
	jsonStart := strings.IndexByte(body, '{')
	if jsonStart == -1 {
		return -1, -1
	}
	jsonEnd := strings.LastIndexByte(body, '}')
	if jsonEnd <= jsonStart {
		return -1, -1
	}
	return jsonStart, jsonEnd
}

// maxSummaryLen 与 TS 版 slice(0, 200) 对齐：错误信息中原文摘要长度上限。
const maxSummaryLen = 200

// summarize 折叠空白后截断原文，用作错误信息中的原文摘要。
func summarize(text string) string {
	summary := strings.Join(strings.Fields(strings.TrimSpace(text)), " ")
	if len(summary) > maxSummaryLen {
		summary = summary[:maxSummaryLen] + "..."
	}
	return summary
}
