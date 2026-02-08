package s3

import "testing"

func TestMergeAndSortOrigins_DedupAndSorted(t *testing.T) {
	static := []string{"https://a.example", "https://b.example", "https://a.example"}
	tenant := []string{"https://c.example", "https://b.example"}

	got := mergeAndSortOrigins(static, tenant)

	want := []string{
		"https://a.example",
		"https://b.example",
		"https://c.example",
	}

	if len(got) != len(want) {
		t.Fatalf("len=%d want=%d got=%v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("idx=%d got=%q want=%q full=%v", i, got[i], want[i], got)
		}
	}
}

