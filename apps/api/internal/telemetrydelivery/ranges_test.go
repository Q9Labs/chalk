package telemetrydelivery

import (
	"reflect"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/sdktelemetry"
)

func set(pairs ...int64) Set {
	ranges := []sdktelemetry.SeqRange{}
	for index := 0; index < len(pairs); index += 2 {
		ranges = append(ranges, sdktelemetry.SeqRange{From: pairs[index], To: pairs[index+1]})
	}
	return NewSet(ranges...)
}

func TestSetOperations(t *testing.T) {
	for _, test := range []struct {
		name                         string
		a, b                         Set
		union, difference, intersect Set
	}{
		{"both empty", set(), set(), set(), set(), set()},
		{"disjoint", set(0, 2), set(5, 7), set(0, 2, 5, 7), set(0, 2), set()},
		{"adjacent ranges merge", set(0, 3), set(3, 6), set(0, 6), set(0, 3), set()},
		{"overlap", set(0, 5), set(3, 8), set(0, 8), set(0, 3), set(3, 5)},
		{"hole punched in the middle", set(0, 10), set(3, 5), set(0, 10), set(0, 3, 5, 10), set(3, 5)},
		{"other covers all", set(2, 4), set(0, 10), set(0, 10), set(), set(2, 4)},
		{"several holes", set(0, 20), set(2, 4, 6, 8, 18, 30), set(0, 30), set(0, 2, 4, 6, 8, 18), set(2, 4, 6, 8, 18, 20)},
		{"unsorted and empty input", NewSet(sdktelemetry.SeqRange{From: 5, To: 6}, sdktelemetry.SeqRange{From: 3, To: 3}, sdktelemetry.SeqRange{From: 0, To: 2}), set(1, 6), set(0, 6), set(0, 1), set(1, 2, 5, 6)},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := test.a.Union(test.b); !reflect.DeepEqual(got, test.union) {
				t.Errorf("union = %v, want %v", got, test.union)
			}
			if got := test.a.Difference(test.b); !reflect.DeepEqual(got, test.difference) {
				t.Errorf("difference = %v, want %v", got, test.difference)
			}
			if got := test.a.Intersect(test.b); !reflect.DeepEqual(got, test.intersect) {
				t.Errorf("intersect = %v, want %v", got, test.intersect)
			}
		})
	}
}

func TestSetContainsCountAndEnd(t *testing.T) {
	s := set(2, 4, 10, 11)
	for seq, want := range map[int64]bool{0: false, 1: false, 2: true, 3: true, 4: false, 9: false, 10: true, 11: false} {
		if got := s.Contains(seq); got != want {
			t.Errorf("Contains(%d) = %v, want %v", seq, got, want)
		}
	}
	if s.Count() != 3 || s.End() != 11 || set().End() != 0 || set().Count() != 0 {
		t.Errorf("count = %d, end = %d, want 3 and 11", s.Count(), s.End())
	}
}

func TestSetsAreNeverNilSoTheyEncodeAsLists(t *testing.T) {
	for name, got := range map[string]Set{"new": NewSet(), "difference": set(0, 1).Difference(set(0, 1)), "intersect": set(0, 1).Intersect(set(5, 6)), "union": set().Union(set())} {
		if got == nil {
			t.Errorf("%s is nil", name)
		}
	}
}
