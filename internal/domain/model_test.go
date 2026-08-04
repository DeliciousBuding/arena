package domain

import "testing"

func TestCellKeyRoundTrip(t *testing.T) {
	positions := []Position{{0, 0}, {20, -97}, {-17, 77}, {-1000, 1000}}
	for _, position := range positions {
		key := CellKey(position[0], position[1])
		parsed, err := ParseCellKey(key)
		if err != nil {
			t.Fatalf("parse %q: %v", key, err)
		}
		if parsed != position {
			t.Errorf("round trip %v -> %q -> %v", position, key, parsed)
		}
	}
}

func TestParseCellKeyRejectsInvalid(t *testing.T) {
	for _, key := range []string{"", "1", "1,2,3", "a,b", "1,", ",2", "1.5,2"} {
		if _, err := ParseCellKey(key); err == nil {
			t.Errorf("expected error for %q", key)
		}
	}
}

func TestSetOperations(t *testing.T) {
	set := NewSet(Position{1, 2}, Position{3, 4})
	if set.Len() != 2 || !set.Contains(Position{1, 2}) || set.Contains(Position{0, 0}) {
		t.Fatalf("set semantics broken")
	}
	clone := set.Clone()
	clone.Add(Position{5, 6})
	if set.Len() != 2 || clone.Len() != 3 {
		t.Errorf("clone must be independent")
	}
}

func TestSetStringKeys(t *testing.T) {
	set := NewSet(CellKey(20, -97), CellKey(-17, 77))
	if !set.Contains("20,-97") || set.Contains("20,-98") {
		t.Fatalf("string-keyed set semantics broken")
	}
	if _, ok := set[CellKey(20, -97)]; !ok {
		t.Errorf("set must be indexable by cell key (map semantics)")
	}
}
