package postgres

import (
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

func TestEnvelopeDeadlineHoldsFollowsAnExtendedCapture(t *testing.T) {
	current := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	signed := func(at time.Time) string { return at.Format(time.RFC3339Nano) }
	for name, test := range map[string]struct {
		kind   recordingpipeline.JobKind
		signed string
		want   bool
	}{
		"capture signed before the extended end": {recordingpipeline.JobKindCapture, signed(current.Add(-30 * time.Minute)), true},
		"capture signed at its end":              {recordingpipeline.JobKindCapture, signed(current), true},
		"capture signed after its end":           {recordingpipeline.JobKindCapture, signed(current.Add(time.Minute)), false},
		"render signed at its end":               {recordingpipeline.JobKindRender, signed(current), true},
		"render signed before its end":           {recordingpipeline.JobKindRender, signed(current.Add(-time.Minute)), false},
		"unreadable deadline":                    {recordingpipeline.JobKindCapture, "tomorrow", false},
	} {
		if got := envelopeDeadlineHolds(test.kind, test.signed, current); got != test.want {
			t.Errorf("%s: holds = %v, want %v", name, got, test.want)
		}
	}
}
