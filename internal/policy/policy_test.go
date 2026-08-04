package policy

import (
	"bytes"
	"strings"
	"testing"
)

// equalPolicy 按值比较 MacroPolicy：FocusRegion 是指针，结构体 == 比较的是
// 指针身份而非指向的内容，解析结果与字面量需按值对比。
func equalPolicy(a, b MacroPolicy) bool {
	if a.Posture != b.Posture || a.WorkerTarget != b.WorkerTarget || a.MilitaryRatio != b.MilitaryRatio || a.AttackTarget != b.AttackTarget {
		return false
	}
	if (a.FocusRegion == nil) != (b.FocusRegion == nil) {
		return false
	}
	if a.FocusRegion != nil && *a.FocusRegion != *b.FocusRegion {
		return false
	}
	return true
}

func TestDefault(t *testing.T) {
	p := Default()
	if p.Posture != PostureBalanced {
		t.Errorf("Default().Posture = %q, want %q", p.Posture, PostureBalanced)
	}
	if p.WorkerTarget != 5 {
		t.Errorf("Default().WorkerTarget = %d, want 5", p.WorkerTarget)
	}
	if p.MilitaryRatio != 0.3 {
		t.Errorf("Default().MilitaryRatio = %v, want 0.3", p.MilitaryRatio)
	}
	if p.FocusRegion != nil {
		t.Errorf("Default().FocusRegion = %v, want nil", p.FocusRegion)
	}
	if p.AttackTarget != "" {
		t.Errorf("Default().AttackTarget = %q, want empty", p.AttackTarget)
	}
	if err := Validate(p); err != nil {
		t.Errorf("Default() must be valid: %v", err)
	}
}

func TestValidateValid(t *testing.T) {
	cases := []struct {
		name string
		p    MacroPolicy
	}{
		{"balanced default", Default()},
		{"aggressive max bounds", MacroPolicy{Posture: PostureAggressive, WorkerTarget: 20, MilitaryRatio: 1}},
		{"defensive min bounds", MacroPolicy{Posture: PostureDefensive, WorkerTarget: 0, MilitaryRatio: 0}},
		{"focus region origin", MacroPolicy{Posture: PostureBalanced, WorkerTarget: 5, MilitaryRatio: 0.3, FocusRegion: &[2]int{0, 0}}},
		{"focus region boundary", MacroPolicy{Posture: PostureBalanced, WorkerTarget: 5, MilitaryRatio: 0.3, FocusRegion: &[2]int{-1000, 1000}}},
		{"attack target", MacroPolicy{Posture: PostureBalanced, WorkerTarget: 5, MilitaryRatio: 0.3, AttackTarget: "enemy_core"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := Validate(tc.p); err != nil {
				t.Errorf("Validate(%+v) = %v, want nil", tc.p, err)
			}
		})
	}
}

func TestValidateRejects(t *testing.T) {
	cases := []struct {
		name string
		p    MacroPolicy
	}{
		{"posture unknown", MacroPolicy{Posture: "unknown", WorkerTarget: 5, MilitaryRatio: 0.3}},
		{"posture empty", MacroPolicy{Posture: "", WorkerTarget: 5, MilitaryRatio: 0.3}},
		{"posture harvest not in go domain", MacroPolicy{Posture: "harvest", WorkerTarget: 5, MilitaryRatio: 0.3}},
		{"worker target -1", MacroPolicy{Posture: PostureBalanced, WorkerTarget: -1, MilitaryRatio: 0.3}},
		{"worker target 21", MacroPolicy{Posture: PostureBalanced, WorkerTarget: 21, MilitaryRatio: 0.3}},
		{"military ratio 1.5", MacroPolicy{Posture: PostureBalanced, WorkerTarget: 5, MilitaryRatio: 1.5}},
		{"military ratio negative", MacroPolicy{Posture: PostureBalanced, WorkerTarget: 5, MilitaryRatio: -0.01}},
		{"focus region x below", MacroPolicy{Posture: PostureBalanced, WorkerTarget: 5, MilitaryRatio: 0.3, FocusRegion: &[2]int{-1001, 0}}},
		{"focus region y above", MacroPolicy{Posture: PostureBalanced, WorkerTarget: 5, MilitaryRatio: 0.3, FocusRegion: &[2]int{0, 1001}}},
		{"focus region one coordinate out", MacroPolicy{Posture: PostureBalanced, WorkerTarget: 5, MilitaryRatio: 0.3, FocusRegion: &[2]int{-1000, 1001}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := Validate(tc.p); err == nil {
				t.Errorf("Validate(%+v) = nil, want error", tc.p)
			}
		})
	}
}

func TestNormalizeClamps(t *testing.T) {
	cases := []struct {
		name string
		in   MacroPolicy
		want MacroPolicy
	}{
		{
			"worker target below",
			MacroPolicy{Posture: PostureBalanced, WorkerTarget: -5, MilitaryRatio: 0.3},
			MacroPolicy{Posture: PostureBalanced, WorkerTarget: 0, MilitaryRatio: 0.3},
		},
		{
			"worker target above",
			MacroPolicy{Posture: PostureBalanced, WorkerTarget: 25, MilitaryRatio: 0.3},
			MacroPolicy{Posture: PostureBalanced, WorkerTarget: 20, MilitaryRatio: 0.3},
		},
		{
			"military ratio below",
			MacroPolicy{Posture: PostureBalanced, WorkerTarget: 5, MilitaryRatio: -0.5},
			MacroPolicy{Posture: PostureBalanced, WorkerTarget: 5, MilitaryRatio: 0},
		},
		{
			"military ratio above",
			MacroPolicy{Posture: PostureBalanced, WorkerTarget: 5, MilitaryRatio: 2},
			MacroPolicy{Posture: PostureBalanced, WorkerTarget: 5, MilitaryRatio: 1},
		},
		{
			"both clamped",
			MacroPolicy{Posture: PostureBalanced, WorkerTarget: -3, MilitaryRatio: 1.5},
			MacroPolicy{Posture: PostureBalanced, WorkerTarget: 0, MilitaryRatio: 1},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Normalize(tc.in); got != tc.want {
				t.Errorf("Normalize(%+v) = %+v, want %+v", tc.in, got, tc.want)
			}
		})
	}
}

func TestNormalizePosture(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"unknown", PostureBalanced},
		{"harvest", PostureBalanced},
		{"", PostureBalanced},
		{PostureAggressive, PostureAggressive},
		{PostureBalanced, PostureBalanced},
		{PostureDefensive, PostureDefensive},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			got := Normalize(MacroPolicy{Posture: tc.in, WorkerTarget: 5, MilitaryRatio: 0.3})
			if got.Posture != tc.want {
				t.Errorf("Normalize(posture=%q).Posture = %q, want %q", tc.in, got.Posture, tc.want)
			}
		})
	}
}

func TestNormalizeValidUnchanged(t *testing.T) {
	in := MacroPolicy{
		Posture:       PostureAggressive,
		WorkerTarget:  7,
		MilitaryRatio: 0.5,
		FocusRegion:   &[2]int{12, -34},
		AttackTarget:  "enemy_workers",
	}
	if got := Normalize(in); got != in {
		t.Errorf("Normalize(%+v) = %+v, want unchanged", in, got)
	}
}

func TestSerializeStable(t *testing.T) {
	p := MacroPolicy{
		Posture:       PostureDefensive,
		WorkerTarget:  12,
		MilitaryRatio: 0.4,
		FocusRegion:   &[2]int{3, -4},
		AttackTarget:  "enemy_core",
	}
	first, err := Serialize(p)
	if err != nil {
		t.Fatalf("Serialize: %v", err)
	}
	second, err := Serialize(p)
	if err != nil {
		t.Fatalf("Serialize: %v", err)
	}
	if !bytes.Equal(first, second) {
		t.Errorf("Serialize twice differs:\n  %s\n  %s", first, second)
	}
}

func TestSerializeFieldOrder(t *testing.T) {
	p := MacroPolicy{
		Posture:       PostureAggressive,
		WorkerTarget:  10,
		MilitaryRatio: 0.6,
		FocusRegion:   &[2]int{1, 2},
		AttackTarget:  "enemy_core",
	}
	data, err := Serialize(p)
	if err != nil {
		t.Fatalf("Serialize: %v", err)
	}
	raw := string(data)
	keys := []string{`"posture"`, `"workerTarget"`, `"militaryRatio"`, `"focusRegion"`, `"attackTarget"`}
	prevIndex := -1
	for _, key := range keys {
		index := strings.Index(raw, key)
		if index == -1 {
			t.Fatalf("serialized output missing key %s: %s", key, raw)
		}
		if index <= prevIndex {
			t.Errorf("key %s out of order (output: %s)", key, raw)
		}
		prevIndex = index
	}
}

func TestSerializeOmitsOptionals(t *testing.T) {
	data, err := Serialize(Default())
	if err != nil {
		t.Fatalf("Serialize: %v", err)
	}
	raw := string(data)
	if strings.Contains(raw, "focusRegion") {
		t.Errorf("nil focusRegion must be omitted, got: %s", raw)
	}
	if strings.Contains(raw, "attackTarget") {
		t.Errorf("empty attackTarget must be omitted, got: %s", raw)
	}
}

func TestParseFencedJSON(t *testing.T) {
	text := "```json\n{\"posture\":\"aggressive\",\"workerTarget\":12,\"militaryRatio\":0.6,\"focusRegion\":[10,-20],\"attackTarget\":\"enemy_core\"}\n```"
	got, err := ParsePolicyText(text)
	if err != nil {
		t.Fatalf("ParsePolicyText: %v", err)
	}
	want := MacroPolicy{
		Posture:       PostureAggressive,
		WorkerTarget:  12,
		MilitaryRatio: 0.6,
		FocusRegion:   &[2]int{10, -20},
		AttackTarget:  "enemy_core",
	}
	if !equalPolicy(got, want) {
		t.Errorf("ParsePolicyText = %+v, want %+v", got, want)
	}
}

func TestParseFencedPlain(t *testing.T) {
	text := "```\n{\"posture\":\"balanced\",\"workerTarget\":5,\"militaryRatio\":0.3}\n```"
	got, err := ParsePolicyText(text)
	if err != nil {
		t.Fatalf("ParsePolicyText: %v", err)
	}
	if got != Default() {
		t.Errorf("ParsePolicyText = %+v, want %+v", got, Default())
	}
}

func TestParseFencedUppercaseJSON(t *testing.T) {
	text := "```JSON\n{\"posture\":\"defensive\",\"workerTarget\":3,\"militaryRatio\":0.2}\n```"
	got, err := ParsePolicyText(text)
	if err != nil {
		t.Fatalf("ParsePolicyText: %v", err)
	}
	want := MacroPolicy{Posture: PostureDefensive, WorkerTarget: 3, MilitaryRatio: 0.2}
	if got != want {
		t.Errorf("ParsePolicyText = %+v, want %+v", got, want)
	}
}

func TestParsePlainJSON(t *testing.T) {
	text := `{"posture":"balanced","workerTarget":8,"militaryRatio":0.4}`
	got, err := ParsePolicyText(text)
	if err != nil {
		t.Fatalf("ParsePolicyText: %v", err)
	}
	want := MacroPolicy{Posture: PostureBalanced, WorkerTarget: 8, MilitaryRatio: 0.4}
	if got != want {
		t.Errorf("ParsePolicyText = %+v, want %+v", got, want)
	}
}

func TestParseMultiLineJSON(t *testing.T) {
	text := "```json\n{\n  \"posture\": \"aggressive\",\n  \"workerTarget\": 15,\n  \"militaryRatio\": 0.7,\n  \"focusRegion\": [4, 5]\n}\n```"
	got, err := ParsePolicyText(text)
	if err != nil {
		t.Fatalf("ParsePolicyText: %v", err)
	}
	want := MacroPolicy{
		Posture:       PostureAggressive,
		WorkerTarget:  15,
		MilitaryRatio: 0.7,
		FocusRegion:   &[2]int{4, 5},
	}
	if !equalPolicy(got, want) {
		t.Errorf("ParsePolicyText = %+v, want %+v", got, want)
	}
}

func TestParseFencedSameLine(t *testing.T) {
	text := "```json {\"posture\":\"balanced\",\"workerTarget\":6,\"militaryRatio\":0.3} ```"
	got, err := ParsePolicyText(text)
	if err != nil {
		t.Fatalf("ParsePolicyText: %v", err)
	}
	want := MacroPolicy{Posture: PostureBalanced, WorkerTarget: 6, MilitaryRatio: 0.3}
	if got != want {
		t.Errorf("ParsePolicyText = %+v, want %+v", got, want)
	}
}

func TestParseFencedNoClosingFence(t *testing.T) {
	text := "```json\n{\"posture\":\"balanced\",\"workerTarget\":5,\"militaryRatio\":0.3}"
	got, err := ParsePolicyText(text)
	if err != nil {
		t.Fatalf("ParsePolicyText: %v", err)
	}
	if got != Default() {
		t.Errorf("ParsePolicyText = %+v, want %+v", got, Default())
	}
}

func TestParseIgnoresSurroundingText(t *testing.T) {
	text := "Sure! Here is the policy JSON:\n```json\n{\"posture\":\"balanced\",\"workerTarget\":5,\"militaryRatio\":0.3}\n```\nHope this helps."
	got, err := ParsePolicyText(text)
	if err != nil {
		t.Fatalf("ParsePolicyText: %v", err)
	}
	if got != Default() {
		t.Errorf("ParsePolicyText = %+v, want %+v", got, Default())
	}
}

func TestParseUnknownFieldsTolerated(t *testing.T) {
	// 与 TS 版 normalize 的"未知字段剔除"语义一致：额外字段不拒绝。
	text := `{"posture":"balanced","workerTarget":5,"militaryRatio":0.3,"extra":"ignored","attackPriority":"core"}`
	got, err := ParsePolicyText(text)
	if err != nil {
		t.Fatalf("ParsePolicyText: %v", err)
	}
	if got != Default() {
		t.Errorf("ParsePolicyText = %+v, want %+v", got, Default())
	}
}

func TestParseRejects(t *testing.T) {
	cases := []struct {
		name string
		text string
	}{
		{"empty", ""},
		{"whitespace only", "  \n\t "},
		{"fences only", "```json\n```"},
		{"lone fence", "```"},
		{"no json object", "model output without braces"},
		{"closing brace only", "}"},
		{"lone opening brace", "{"},
		{"invalid json", "{not json}"},
		{"truncated json", `{"posture":"balanced"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParsePolicyText(tc.text); err == nil {
				t.Errorf("ParsePolicyText(%q) = nil error, want error", tc.text)
			}
		})
	}
}

func TestParseRejectsInvalidValue(t *testing.T) {
	cases := []struct {
		name string
		text string
	}{
		{"posture unknown", `{"posture":"unknown","workerTarget":5,"militaryRatio":0.3}`},
		{"posture missing", `{"workerTarget":5,"militaryRatio":0.3}`},
		{"worker target -1", `{"posture":"balanced","workerTarget":-1,"militaryRatio":0.3}`},
		{"worker target 21", `{"posture":"balanced","workerTarget":21,"militaryRatio":0.3}`},
		{"military ratio 1.5", `{"posture":"balanced","workerTarget":5,"militaryRatio":1.5}`},
		{"focus region out of range", `{"posture":"balanced","workerTarget":5,"militaryRatio":0.3,"focusRegion":[1001,0]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParsePolicyText(tc.text); err == nil {
				t.Errorf("ParsePolicyText(%s) = nil error, want error", tc.text)
			}
		})
	}
}

func TestParseErrorIncludesSummary(t *testing.T) {
	text := "the model replied with\n```json\n{\"posture\":\"unknown\",\"workerTarget\":5,\"militaryRatio\":0.3}\n```"
	_, err := ParsePolicyText(text)
	if err == nil {
		t.Fatal("ParsePolicyText = nil error, want error")
	}
	if !strings.Contains(err.Error(), "the model replied with") {
		t.Errorf("error must include original text summary, got: %v", err)
	}
	if !strings.Contains(err.Error(), "posture") {
		t.Errorf("error must include validation cause, got: %v", err)
	}
}

func TestParseErrorTruncatesLongSummary(t *testing.T) {
	longText := strings.Repeat("noise ", 100) + `{"posture":"unknown"}`
	_, err := ParsePolicyText(longText)
	if err == nil {
		t.Fatal("ParsePolicyText = nil error, want error")
	}
	if count := strings.Count(err.Error(), "noise"); count > 50 {
		t.Errorf("error must truncate long original text, got %d noise occurrences", count)
	}
}

func TestParseRoundTrip(t *testing.T) {
	text := "```json\n{\"posture\":\"aggressive\",\"workerTarget\":14,\"militaryRatio\":0.8,\"focusRegion\":[3,3],\"attackTarget\":\"enemy_core\"}\n```"
	got, err := ParsePolicyText(text)
	if err != nil {
		t.Fatalf("ParsePolicyText: %v", err)
	}
	data, err := Serialize(got)
	if err != nil {
		t.Fatalf("Serialize: %v", err)
	}
	const want = `{"posture":"aggressive","workerTarget":14,"militaryRatio":0.8,"focusRegion":[3,3],"attackTarget":"enemy_core"}`
	if string(data) != want {
		t.Errorf("round trip = %s, want %s", data, want)
	}
}
