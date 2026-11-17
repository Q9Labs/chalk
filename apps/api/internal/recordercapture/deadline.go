package recordercapture

import (
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

// MaximumDeadlineExtension bounds how far past its signed end a capture may be carried: a Recording
// never runs longer than the recording limit, and the signed end is at least the Recording's start.
const MaximumDeadlineExtension = recordingpipeline.MaximumRecordingDuration

// Deadline carries the end a capture plan moved a capture to. A capture ends where its envelope
// was signed until a plan carries a later end, which is how a Recording follows a call that was extended.
type Deadline struct {
	mu    sync.Mutex
	later time.Time
	moved chan struct{}
}

// NewDeadline starts a capture that has not been moved past the end it was signed with.
func NewDeadline() *Deadline {
	return &Deadline{moved: make(chan struct{}, 1)}
}

// EndsAt is the capture's current end. An authority built without a Deadline ends where it was signed.
func (a AttemptAuthority) EndsAt() time.Time {
	if a.Deadline == nil {
		return a.HardDeadline
	}
	a.Deadline.mu.Lock()
	defer a.Deadline.mu.Unlock()
	return a.endsAtLocked()
}

func (a AttemptAuthority) endsAtLocked() time.Time {
	if a.Deadline.later.After(a.HardDeadline) {
		return a.Deadline.later
	}
	return a.HardDeadline
}

// DeadlineMoved fires after the end moves. It is nil, and never fires, for an authority without a Deadline.
func (a AttemptAuthority) DeadlineMoved() <-chan struct{} {
	if a.Deadline == nil {
		return nil
	}
	return a.Deadline.moved
}

// FollowPlan moves the end to the plan's when that is later. A plan never shortens a capture:
// an earlier end for the call stops the Recording through the Episode's own end.
func (a AttemptAuthority) FollowPlan(plan captureplan.Plan) {
	if a.Deadline == nil {
		return
	}
	a.Deadline.mu.Lock()
	defer a.Deadline.mu.Unlock()
	if !plan.EffectiveDeadline().After(a.endsAtLocked()) {
		return
	}
	a.Deadline.later = plan.EffectiveDeadline().UTC()
	select {
	case a.Deadline.moved <- struct{}{}:
	default:
	}
}
