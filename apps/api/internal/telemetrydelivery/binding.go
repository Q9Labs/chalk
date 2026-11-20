package telemetrydelivery

import (
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// ErrSourceBound says a batch touches a source that is bound to another participant, and the
// batch's participant is not a successor of it. The batch is refused as a whole and nothing is
// settled.
var ErrSourceBound = errors.New("telemetry source is bound to another participant")

// Binding ties a source to the first participant that sent a batch touching it, as its own source
// or as a predecessor a drop record names. Only that participant and its successors may add
// claims to the source, so another participant that learns a source_id cannot hide its gaps.
type Binding struct {
	TenantID      utilities.ID
	SourceID      utilities.ID
	ParticipantID utilities.ID
	// IdentityID is the User or Agent the bound participant is, or zero for a guest.
	IdentityID utilities.ID
	BoundAt    time.Time
}

// Claimant is the participant a batch's credential names, with the User or Agent the ledger
// found for it in the participant's row. IdentityID is zero for a guest or for a participant
// whose row is gone.
type Claimant struct {
	ParticipantID utilities.ID
	IdentityID    utilities.ID
}

// NewBinding is the binding a source gets from the first batch that touches it.
func NewBinding(tenant, source utilities.ID, claimant Claimant, at time.Time) Binding {
	return Binding{TenantID: tenant, SourceID: source, ParticipantID: claimant.ParticipantID, IdentityID: claimant.IdentityID, BoundAt: at}
}

// Permits says whether the claimant may write to the bound source: it is the bound participant,
// or a successor of it, which is a later participant of the same User or Agent (a rejoin gets a
// new participant id). A source bound to a guest has no successors.
func (b Binding) Permits(claimant Claimant) bool {
	if claimant.ParticipantID == b.ParticipantID {
		return true
	}
	return !b.IdentityID.IsZero() && claimant.IdentityID == b.IdentityID
}

// Authorize is nil when the claimant may write to every source the bindings bind, and
// ErrSourceBound when any one refuses it.
func Authorize(bindings []Binding, claimant Claimant) error {
	for _, binding := range bindings {
		if !binding.Permits(claimant) {
			return ErrSourceBound
		}
	}
	return nil
}
