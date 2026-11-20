package telemetrydelivery_test

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/sdktelemetry"
	"github.com/q9labs/chalk/apps/api/internal/telemetrydelivery"
	"github.com/q9labs/chalk/apps/api/internal/telemetrydelivery/ledgertest"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type memoryWorld struct {
	ledger   *telemetrydelivery.MemoryLedger
	tenant   utilities.ID
	episodes [2]utilities.ID
	joined   int
}

func newID(t *testing.T, prefix string, n int) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(fmt.Sprintf("%s-0000-4000-8000-%012d", prefix, n))
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func (w *memoryWorld) Ledger() ledgertest.Ledger { return w.ledger }

func (w *memoryWorld) Join(t *testing.T, episode int) telemetrydelivery.Identity {
	w.joined++
	identity := telemetrydelivery.Identity{TenantID: w.tenant, EpisodeID: w.episodes[episode], ParticipantID: newID(t, "33333333", w.joined)}
	w.ledger.Join(identity)
	return identity
}

func (w *memoryWorld) Purge(*testing.T) { w.ledger.Purge(w.tenant) }

func TestMemoryLedgerKeepsTheLedgerContract(t *testing.T) {
	ledgertest.Run(t, func(t *testing.T) ledgertest.World {
		return &memoryWorld{
			ledger: &telemetrydelivery.MemoryLedger{}, tenant: newID(t, "11111111", 1),
			episodes: [2]utilities.ID{newID(t, "22222222", 1), newID(t, "22222222", 2)},
		}
	})
}

// A failed commit leaves the row as it was, so the retry finds its records new.
func TestMemoryLedgerFailedCommitChangesNothing(t *testing.T) {
	world := &memoryWorld{ledger: &telemetrydelivery.MemoryLedger{}, tenant: newID(t, "11111111", 1), episodes: [2]utilities.ID{newID(t, "22222222", 1)}}
	owner := world.Join(t, 0)
	request := ledgertest.Batch(t, ledgertest.SourceID(1), 2, "", ledgertest.Record(0), ledgertest.Record(1))
	failure := errors.New("commit failed")
	world.ledger.FailCommit = failure
	if _, err := world.ledger.Admit(t.Context(), owner, request, time.Now(), sdktelemetry.Stamp{}); !errors.Is(err, failure) {
		t.Fatalf("err = %v, want the commit's", err)
	}
	if _, found, _ := world.ledger.Source(t.Context(), owner.TenantID, ledgertest.SourceID(1)); found {
		t.Fatal("a row exists after a failed commit")
	}
	world.ledger.FailCommit = nil
	admission, err := world.ledger.Admit(t.Context(), owner, request, time.Now(), sdktelemetry.Stamp{})
	if err != nil || len(admission.New) != 2 {
		t.Fatalf("retry: new = %d, err = %v, want both records new", len(admission.New), err)
	}
	world.ledger.Fail = errors.New("down")
	if _, _, err := world.ledger.Source(t.Context(), owner.TenantID, ledgertest.SourceID(1)); err == nil {
		t.Fatal("a failing ledger must fail reads")
	}
}
