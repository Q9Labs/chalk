package spaces

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestAdmissionPolicyRejectsRetiredMembersOnly(t *testing.T) {
	for _, mode := range []string{"open", "knock"} {
		if _, err := prepareAdmissionPolicy(json.RawMessage(`{"mode":"` + mode + `"}`)); err != nil {
			t.Fatalf("%s: %v", mode, err)
		}
	}
	if _, err := prepareAdmissionPolicy(json.RawMessage(`{"mode":"members_only"}`)); !errors.Is(err, ErrInvalidAdmissionPolicy) {
		t.Fatalf("retired policy: %v", err)
	}
}
