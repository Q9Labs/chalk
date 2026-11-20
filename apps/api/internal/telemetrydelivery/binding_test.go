package telemetrydelivery

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/sdktelemetry"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	participantSecond = "44444444-4444-4444-8444-444444444444"
	identityUser      = "66666666-6666-4666-8666-666666666666"
	identityOther     = "77777777-7777-4777-8777-777777777777"
)

func TestBindingPermitsItsParticipantAndSuccessorsOfItsIdentityOnly(t *testing.T) {
	first := identity(t).ParticipantID
	second := id(t, participantSecond)
	user, other := id(t, identityUser), id(t, identityOther)
	userBound := NewBinding(identity(t).TenantID, id(t, sourceA), Claimant{ParticipantID: first, IdentityID: user}, received)
	guestBound := NewBinding(identity(t).TenantID, id(t, sourceA), Claimant{ParticipantID: first}, received)

	tests := []struct {
		name     string
		binding  Binding
		claimant Claimant
		want     bool
	}{
		{"the bound participant", userBound, Claimant{ParticipantID: first, IdentityID: user}, true},
		{"the bound guest", guestBound, Claimant{ParticipantID: first}, true},
		{"a successor of the same identity", userBound, Claimant{ParticipantID: second, IdentityID: user}, true},
		{"another identity", userBound, Claimant{ParticipantID: second, IdentityID: other}, false},
		{"a guest on an identity's source", userBound, Claimant{ParticipantID: second}, false},
		{"a guest on a guest's source", guestBound, Claimant{ParticipantID: second}, false},
		{"an identity on a guest's source", guestBound, Claimant{ParticipantID: second, IdentityID: user}, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := test.binding.Permits(test.claimant); got != test.want {
				t.Fatalf("Permits = %v, want %v", got, test.want)
			}
			wantErr := error(nil)
			if !test.want {
				wantErr = ErrSourceBound
			}
			if err := Authorize([]Binding{test.binding}, test.claimant); !errors.Is(err, wantErr) {
				t.Fatalf("Authorize = %v, want %v", err, wantErr)
			}
		})
	}
}

func TestAuthorizeRefusesWhenAnyBindingRefuses(t *testing.T) {
	mine := Claimant{ParticipantID: identity(t).ParticipantID}
	own := NewBinding(identity(t).TenantID, id(t, sourceA), mine, received)
	foreign := NewBinding(identity(t).TenantID, id(t, sourceB), Claimant{ParticipantID: id(t, participantSecond)}, received)
	if err := Authorize([]Binding{own, foreign}, mine); !errors.Is(err, ErrSourceBound) {
		t.Fatalf("Authorize = %v, want ErrSourceBound when a predecessor is bound to another participant", err)
	}
}

func TestMemoryLedgerBindsEverySourceToItsFirstParticipant(t *testing.T) {
	noSink := func(context.Context, Admission) error { return nil }
	ledger := &MemoryLedger{}
	first := identity(t)
	// A batch of source B that names source A as a predecessor binds both.
	if _, err := ledger.Admit(t.Context(), first, batch(t, sourceB, 1, "", drop(0, 3, 5, "queue_full", sourceA)), received, noSink); err != nil {
		t.Fatal(err)
	}
	for _, source := range []string{sourceA, sourceB} {
		binding, found := ledger.bindings[bindingKey{first.TenantID, id(t, source)}]
		if !found || binding.ParticipantID != first.ParticipantID || !binding.IdentityID.IsZero() || !binding.BoundAt.Equal(received) {
			t.Fatalf("binding of %s = %+v, %v, want it bound to the first participant as a guest", source, binding, found)
		}
	}
	if _, err := ledger.Admit(t.Context(), first, batch(t, sourceA, 2, "", ended(0), ended(1)), received, noSink); err != nil {
		t.Fatalf("the bound participant: %v", err)
	}
}

func TestMemoryLedgerRefusesAnotherParticipantAndChangesNothing(t *testing.T) {
	noSink := func(context.Context, Admission) error { return nil }
	ledger := &MemoryLedger{}
	victim := identity(t)
	if _, err := ledger.Admit(t.Context(), victim, batch(t, sourceA, 4, "", ended(0)), received, noSink); err != nil {
		t.Fatal(err)
	}
	before, _ := ledger.Source(t.Context(), victim.TenantID, id(t, sourceA))

	hostile := victim
	hostile.ParticipantID = id(t, participantSecond)
	attacks := []sdktelemetry.Request{
		// Records under the victim's source with a close that hides its tail, and a drop record of
		// the hostile participant's own source that names the victim's missing seqs.
		batch(t, sourceA, 4, "closed", ended(1), ended(2), ended(3)),
		batch(t, sourceB, 1, "", drop(0, 1, 4, "queue_full", sourceA)),
	}
	for _, attack := range attacks {
		sunk := false
		_, err := ledger.Admit(t.Context(), hostile, attack, received, func(context.Context, Admission) error {
			sunk = true
			return nil
		})
		if !errors.Is(err, ErrSourceBound) || sunk {
			t.Fatalf("hostile batch: err = %v, sink written = %v, want ErrSourceBound before the sink", err, sunk)
		}
	}
	after, _ := ledger.Source(t.Context(), victim.TenantID, id(t, sourceA))
	if len(after) != len(before) || len(after) != 1 || after[0].End != EndNone {
		t.Fatalf("victim rows = %+v, want them unchanged: %+v", after, before)
	}
	if _, found := ledger.bindings[bindingKey{victim.TenantID, id(t, sourceB)}]; found {
		t.Fatal("a refused batch bound its own source")
	}
	if gaps, _ := Gaps(after); len(gaps) != 2 || gaps[0].Cause != GapMissing || gaps[0].FromSeq != 1 {
		t.Fatalf("victim gaps = %+v, want [1,4) still missing and the open tail", gaps)
	}
}

func TestMemoryLedgerAcceptsASuccessorOfTheSameIdentity(t *testing.T) {
	noSink := func(context.Context, Admission) error { return nil }
	first := identity(t)
	successor := first
	successor.ParticipantID = id(t, participantSecond)
	ledger := &MemoryLedger{Identities: map[utilities.ID]utilities.ID{first.ParticipantID: id(t, identityUser), successor.ParticipantID: id(t, identityUser)}}
	if _, err := ledger.Admit(t.Context(), first, batch(t, sourceA, 1, "", ended(0)), received, noSink); err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.Admit(t.Context(), successor, batch(t, sourceA, 2, "closed", ended(1)), received, noSink); err != nil {
		t.Fatalf("the successor: %v", err)
	}
	if rows, _ := ledger.Source(t.Context(), first.TenantID, id(t, sourceA)); len(rows) != 2 {
		t.Fatalf("rows = %d, want one per participant", len(rows))
	}
	ledger.Identities[successor.ParticipantID] = id(t, identityOther)
	if _, err := ledger.Admit(t.Context(), successor, batch(t, sourceA, 3, "", ended(2)), received, noSink); !errors.Is(err, ErrSourceBound) {
		t.Fatalf("another identity: err = %v, want ErrSourceBound", err)
	}
}
