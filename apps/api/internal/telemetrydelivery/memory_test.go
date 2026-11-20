package telemetrydelivery

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestMemoryLedgerWritesTheSinkBeforeItCommitsAndRetriesWriteAgain(t *testing.T) {
	ledger := &MemoryLedger{}
	request := batch(t, sourceA, 2, "", ended(0), ended(1))
	var written [][]int64
	write := func(_ context.Context, admission Admission) error {
		written = append(written, seqsOf(admission.New))
		return nil
	}

	ledger.CrashAfterSink = errors.New("crash")
	if _, err := ledger.Admit(t.Context(), identity(t), request, received, write); err == nil {
		t.Fatal("a crash after the sink write must fail the call")
	}
	rows, _ := ledger.Source(t.Context(), identity(t).TenantID, id(t, sourceA))
	if len(rows) != 0 {
		t.Fatalf("rows = %v after a crash between the sink and the commit, want none", rows)
	}

	ledger.CrashAfterSink = nil
	if _, err := ledger.Admit(t.Context(), identity(t), request, received, write); err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.Admit(t.Context(), identity(t), request, received, write); err != nil {
		t.Fatal(err)
	}
	if want := [][]int64{{0, 1}, {0, 1}, {}}; !reflect.DeepEqual(written, want) {
		t.Fatalf("sink writes = %v, want %v: the retry after the crash writes again, and the one after the commit writes nothing", written, want)
	}
}

func TestMemoryLedgerLeavesRowsAloneWhenTheSinkFails(t *testing.T) {
	ledger := &MemoryLedger{}
	failure := errors.New("sink down")
	if _, err := ledger.Admit(t.Context(), identity(t), batch(t, sourceA, 1, "", ended(0)), received, func(context.Context, Admission) error { return failure }); !errors.Is(err, failure) {
		t.Fatalf("error = %v, want the sink's", err)
	}
	if rows, _ := ledger.Episode(t.Context(), identity(t).TenantID, identity(t).EpisodeID); len(rows) != 0 {
		t.Fatalf("rows = %v, want none", rows)
	}
}

func TestMemoryLedgerKeepsRowsPerParticipantAndReadsThemBack(t *testing.T) {
	noSink := func(context.Context, Admission) error { return nil }
	first := identity(t)
	second := first
	second.ParticipantID = id(t, participantSecond)
	// The second participant is the same User rejoined, so it may write to the source.
	ledger := &MemoryLedger{Identities: map[utilities.ID]utilities.ID{first.ParticipantID: id(t, identityUser), second.ParticipantID: id(t, identityUser)}}

	// The same seqs under another participant are new, not duplicates: a credential cannot mark
	// another participant's seqs as stored.
	for _, who := range []Identity{first, second} {
		admission, err := ledger.Admit(t.Context(), who, batch(t, sourceA, 2, "", ended(0), ended(1)), received, noSink)
		if err != nil || admission.Duplicates != 0 || len(admission.New) != 2 {
			t.Fatalf("participant %s: duplicates = %d, new = %d, err = %v", who.ParticipantID, admission.Duplicates, len(admission.New), err)
		}
	}
	rows, err := ledger.Source(t.Context(), first.TenantID, id(t, sourceA))
	if err != nil || len(rows) != 2 {
		t.Fatalf("source rows = %v, %v, want one per participant", rows, err)
	}
	if byEpisode, _ := ledger.Episode(t.Context(), first.TenantID, first.EpisodeID); len(byEpisode) != 2 {
		t.Fatalf("episode rows = %d, want 2", len(byEpisode))
	}
	if other, _ := ledger.Episode(t.Context(), first.TenantID, id(t, "55555555-5555-4555-8555-555555555555")); len(other) != 0 {
		t.Fatalf("another Episode's rows = %v, want none", other)
	}

	ledger.Fail = errors.New("down")
	if _, err := ledger.Source(t.Context(), first.TenantID, id(t, sourceA)); err == nil {
		t.Fatal("a failing ledger must fail reads")
	}
}
