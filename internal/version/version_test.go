package version

import "testing"

func TestInfoDefaults(t *testing.T) {
	t.Parallel()
	info := Info()
	if info.SHA == "" || info.Tag == "" || info.BuiltAt == "" || info.SchemaHash == "" {
		t.Fatalf("version info fields must never be empty: %+v", info)
	}
}

func TestShortSHA(t *testing.T) {
	t.Parallel()
	long := "0123456789abcdef0123456789abcdef01234567"
	info := InfoSnapshot{SHA: long}
	if got := info.ShortSHA(); got != long[:12] {
		t.Fatalf("ShortSHA() = %q, want first 12 chars", got)
	}
	short := InfoSnapshot{SHA: "abc"}
	if got := short.ShortSHA(); got != "abc" {
		t.Fatalf("ShortSHA() = %q for short input, want input unchanged", got)
	}
}
