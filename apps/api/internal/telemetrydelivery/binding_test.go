package telemetrydelivery

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

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
			if _, err := Authorize([]Binding{test.binding}, test.claimant, id(t, sourceA)); !errors.Is(err, wantErr) {
				t.Fatalf("Authorize = %v, want %v", err, wantErr)
			}
		})
	}
}

func TestAuthorizeRefusesOnlyWhenTheOwnSourceRefuses(t *testing.T) {
	mine := Claimant{ParticipantID: identity(t).ParticipantID}
	other := Claimant{ParticipantID: id(t, participantSecond)}
	own := NewBinding(identity(t).TenantID, id(t, sourceB), mine, received)
	foreign := NewBinding(identity(t).TenantID, id(t, sourceA), other, received)
	barred, err := Authorize([]Binding{foreign, own}, mine, id(t, sourceB))
	if err != nil || len(barred) != 1 || barred[0] != id(t, sourceA) {
		t.Fatalf("Authorize = %v, %v, want only the predecessor barred", barred, err)
	}
	if _, err := Authorize([]Binding{foreign, own}, mine, id(t, sourceA)); !errors.Is(err, ErrSourceBound) {
		t.Fatalf("Authorize = %v, want ErrSourceBound when the own source is bound to another participant", err)
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
	// Records under the victim's source with a close that hides its tail, and a drop record that
	// names an unbound source, which a refused batch must not bind.
	attack := batch(t, sourceA, 5, "closed", ended(1), ended(2), ended(3), drop(4, 0, 2, "queue_full", sourceB))
	sunk := false
	_, err := ledger.Admit(t.Context(), hostile, attack, received, func(context.Context, Admission) error {
		sunk = true
		return nil
	})
	if !errors.Is(err, ErrSourceBound) || sunk {
		t.Fatalf("hostile batch: err = %v, sink written = %v, want ErrSourceBound before the sink", err, sunk)
	}
	after, _ := ledger.Source(t.Context(), victim.TenantID, id(t, sourceA))
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("victim rows = %+v, want them unchanged: %+v", after, before)
	}
	if _, found := ledger.bindings[bindingKey{victim.TenantID, id(t, sourceB)}]; found {
		t.Fatal("a refused batch bound the predecessor its drop record names")
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
	// The successor's drop record for the old source, sent on its own new source, is applied.
	predecessorDrop, err := ledger.Admit(t.Context(), successor, batch(t, sourceB, 1, "", drop(0, 2, 4, "queue_full", sourceA)), received, noSink)
	if err != nil || len(predecessorDrop.New) != 1 || predecessorDrop.New[0].Rejection() != "" {
		t.Fatalf("the successor's drop record: %+v, %v, want it stored", predecessorDrop, err)
	}
	if row := rowOf(t, predecessorDrop, sourceA); !reflect.DeepEqual(row.Ranges.Dropped["queue_full"], Set{{From: 2, To: 4}}) {
		t.Fatalf("old source dropped = %+v, want [2,4) for queue_full", row.Ranges.Dropped)
	}
	ledger.Identities[successor.ParticipantID] = id(t, identityOther)
	if _, err := ledger.Admit(t.Context(), successor, batch(t, sourceA, 3, "", ended(2)), received, noSink); !errors.Is(err, ErrSourceBound) {
		t.Fatalf("another identity: err = %v, want ErrSourceBound", err)
	}
}

// A guest reload: the new participant is not a successor of the guest that bound the old source,
// so its drop record for the old source is settled as rejected and changes nothing there, while
// the live records of its own source land.
func TestMemoryLedgerRejectsADropRecordForABarredPredecessorAndAdmitsTheRest(t *testing.T) {
	var sunk []sdktelemetry.Event
	sink := func(_ context.Context, admission Admission) error {
		sunk = admission.New
		return nil
	}
	ledger := &MemoryLedger{}
	guestA := identity(t)
	if _, err := ledger.Admit(t.Context(), guestA, batch(t, sourceA, 4, "", ended(0)), received, sink); err != nil {
		t.Fatal(err)
	}
	before, _ := ledger.Source(t.Context(), guestA.TenantID, id(t, sourceA))

	guestB := guestA
	guestB.ParticipantID = id(t, participantSecond)
	reload := batch(t, sourceB, 2, "", drop(0, 1, 4, "queue_full", sourceA), ended(1))
	later := received.Add(time.Minute)
	admission, err := ledger.Admit(t.Context(), guestB, reload, later, sink)
	if err != nil {
		t.Fatalf("reload batch: %v", err)
	}
	if len(sunk) != 2 || sunk[0].Rejection() != SourceBound || sunk[1].Rejection() != "" {
		t.Fatalf("sink events = %+v, want the drop record rejected as source_bound and the live record valid", sunk)
	}
	if eventType, seq := sunk[0].Seen(); eventType != "telemetry_dropped" || seq != 0 {
		t.Fatalf("rejected drop record reads as %q seq %d, want telemetry_dropped seq 0", eventType, seq)
	}
	if got := Acks(reload, admission.Settled); !reflect.DeepEqual(got, []sdktelemetry.SeqRange{{From: 0, To: 2}}) {
		t.Fatalf("acks = %+v, want both seqs settled", got)
	}
	live, _ := ledger.Source(t.Context(), guestA.TenantID, id(t, sourceB))
	if len(live) != 1 || live[0].ParticipantID != guestB.ParticipantID || !live[0].Ranges.Stored.Contains(1) || !live[0].Ranges.Rejected.Contains(0) || live[0].Ranges.Stored.Contains(0) {
		t.Fatalf("live rows = %+v, want seq 1 stored and the drop record seq 0 rejected", live)
	}
	after, _ := ledger.Source(t.Context(), guestA.TenantID, id(t, sourceA))
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("source A rows = %+v, want them unchanged: %+v", after, before)
	}
	if gaps, _ := Gaps(after); len(gaps) != 2 || gaps[0].Cause != GapMissing || gaps[0].FromSeq != 1 || gaps[0].Status != GapOpen {
		t.Fatalf("source A gaps = %+v, want [1,4) still missing and open", gaps)
	}
	if binding := ledger.bindings[bindingKey{guestA.TenantID, id(t, sourceA)}]; binding.ParticipantID != guestA.ParticipantID {
		t.Fatalf("source A binding = %+v, want it still bound to the first guest", binding)
	}
	// The SDK gets the drop record acked, so a retry is a duplicate and nothing changes.
	retry, err := ledger.Admit(t.Context(), guestB, reload, later, sink)
	if err != nil || retry.Duplicates != 2 || len(retry.New) != 0 {
		t.Fatalf("retry = %+v, %v, want both records duplicates", retry, err)
	}
}
