package spaces

import (
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestChalkSFUAllowlistNamesSpacesOnly(t *testing.T) {
	listed, err := utilities.ParseID("11111111-1111-4111-8111-111111111111")
	if err != nil {
		t.Fatal(err)
	}
	other, err := utilities.ParseID("22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}

	list, err := ParseChalkSFUAllowlist([]string{listed.String()})
	if err != nil {
		t.Fatal(err)
	}
	if !list.Allows(listed) || list.Allows(other) || list.Size() != 1 {
		t.Fatalf("listed=%v other=%v size=%d", list.Allows(listed), list.Allows(other), list.Size())
	}
	if (ChalkSFUAllowlist{}).Allows(listed) {
		t.Fatal("the zero allowlist must allow no Space")
	}
	everyone, err := ParseChalkSFUAllowlist([]string{"*"})
	if err != nil || !everyone.Allows(other) || everyone.Size() != -1 {
		t.Fatalf("* allows every Space: %v, %d, %v", everyone.Allows(other), everyone.Size(), err)
	}
	if _, err := ParseChalkSFUAllowlist([]string{"not-a-space"}); err == nil {
		t.Fatal("a malformed entry must fail the parse, not silently shrink the list")
	}
}
