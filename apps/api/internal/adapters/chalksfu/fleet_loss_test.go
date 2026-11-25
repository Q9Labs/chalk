package chalksfu

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func TestWindowLossRequiresJournalConfirmationOnAColdFleet(t *testing.T) {
	allocation := mediaplane.Allocation{Node: mediaplane.WindowNodePrefix + "0f260b44-0345-41d4-9cbd-a25191f25508"}
	for _, tc := range []struct {
		name string
		gone bool
		err  error
		lost bool
	}{
		{name: "newly bound"},
		{name: "directory unavailable", err: errors.New("database is unavailable")},
		{name: "provider absence recorded", gone: true, lost: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fleet := &Fleet{}
			fleet.LoadWindowNodes(WindowDirectory{Gone: func(_ context.Context, node string) (bool, error) {
				if node != allocation.Node {
					t.Fatalf("got %q, want %q", node, allocation.Node)
				}
				return tc.gone, tc.err
			}})
			reason, lost := fleet.Confirm(t.Context(), allocation)
			if lost != tc.lost || lost && reason != LossSilent {
				t.Fatalf("loss=(%q, %v), want lost=%v", reason, lost, tc.lost)
			}
		})
	}
}
