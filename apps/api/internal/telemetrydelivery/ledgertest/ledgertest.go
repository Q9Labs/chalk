// Package ledgertest is the contract every telemetry ledger keeps, as one suite that runs against
// telemetrydelivery.MemoryLedger and the Postgres ledger alike, so the two cannot drift.
package ledgertest

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/sdktelemetry"
	"github.com/q9labs/chalk/apps/api/internal/telemetrydelivery"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// Ledger is what a telemetry ledger offers its callers.
type Ledger interface {
	Admit(ctx context.Context, identity telemetrydelivery.Identity, batch sdktelemetry.Request, received time.Time, stamp sdktelemetry.Stamp) (telemetrydelivery.Admission, error)
	Live(ctx context.Context, identity telemetrydelivery.Identity) error
	Source(ctx context.Context, tenant, source utilities.ID) (telemetrydelivery.SourceRow, bool, error)
	Episode(ctx context.Context, tenant, episode utilities.ID) ([]telemetrydelivery.SourceRow, error)
}

// World is one empty ledger with one tenant of two Episodes.
type World interface {
	Ledger() Ledger
	// Join makes a new live participant in Episode 0 or 1 of the tenant.
	Join(t *testing.T, episode int) telemetrydelivery.Identity
	// Purge removes the tenant the way a tenant purge does: every row with its tenant_id, then the
	// tenant itself.
	Purge(t *testing.T)
}

var received = time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)

// Run runs the suite, with a fresh world for every case.
func Run(t *testing.T, fresh func(t *testing.T) World) {
	cases := []struct {
		name string
		run  func(t *testing.T, world World)
	}{
		{"a batch is settled once and its retry is all duplicates", settlesOnce},
		{"only the owner's credential writes a source", oneOwner},
		{"a participant that was never live is refused", neverLive},
		{"a purged tenant's credential recreates nothing", purgeFence},
		{"a participant's new sources are bounded", sourceBudget},
		{"a long call's page loads are all admitted", manyReloads},
		{"an empty close of a fresh source allocates one row", emptyClose},
		{"a short close is refused and its suffix stays a gap", shortClose},
		{"a rejected seq is settled and is a gap", rejectedGap},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) { test.run(t, fresh(t)) })
	}
}

func settlesOnce(t *testing.T, world World) {
	owner := world.Join(t, 0)
	request := Batch(t, SourceID(1), 3, "", Record(0), Record(1), Record(2))
	first := mustAdmit(t, world, owner, request)
	again := mustAdmit(t, world, owner, request)
	if len(first.New) != 3 || first.Duplicates != 0 || len(again.New) != 0 || again.Duplicates != 3 {
		t.Fatalf("first new = %d, duplicates = %d; retry new = %d, duplicates = %d; want 3 new then 3 duplicates", len(first.New), first.Duplicates, len(again.New), again.Duplicates)
	}
	if !reflect.DeepEqual(first.Settled, again.Settled) {
		t.Fatalf("settled = %v then %v, want the same", first.Settled, again.Settled)
	}
	row := source(t, world, owner, SourceID(1))
	if row.Owner() != owner || !reflect.DeepEqual(row.Ranges.Stored, telemetrydelivery.NewSet(sdktelemetry.SeqRange{From: 0, To: 3})) {
		t.Fatalf("row = %+v, want [0,3) stored, owned by %+v", row, owner)
	}
}

// Another participant of the Episode, and the same User's participant in another Episode, are both
// other owners: neither can add records or an end to the source, and the source shows only in its
// owner's Episode.
func oneOwner(t *testing.T, world World) {
	owner, neighbour, elsewhere := world.Join(t, 0), world.Join(t, 0), world.Join(t, 1)
	mustAdmit(t, world, owner, Batch(t, SourceID(1), 3, "", Record(0), Record(1), Record(2)))
	before := source(t, world, owner, SourceID(1))
	for _, other := range []telemetrydelivery.Identity{neighbour, elsewhere} {
		_, err := world.Ledger().Admit(t.Context(), other, Batch(t, SourceID(1), 4, "closed", Record(3)), received, sdktelemetry.Stamp{})
		if !errors.Is(err, telemetrydelivery.ErrSourceOwned) {
			t.Fatalf("participant %s wrote the source of %s: err = %v", other.ParticipantID, owner.ParticipantID, err)
		}
	}
	if after := source(t, world, owner, SourceID(1)); !reflect.DeepEqual(after, before) {
		t.Fatalf("row after the refused batches = %+v, want it unchanged: %+v", after, before)
	}
	if rows := episode(t, world, elsewhere); len(rows) != 0 {
		t.Fatalf("the other Episode reads %d rows, want none", len(rows))
	}
	if rows := episode(t, world, owner); len(rows) != 1 || rows[0].SourceID != SourceID(1) {
		t.Fatalf("the owner's Episode reads %+v, want only its source", rows)
	}
}

func neverLive(t *testing.T, world World) {
	live := world.Join(t, 0)
	stranger := live
	stranger.ParticipantID = SourceID(99)
	if _, err := world.Ledger().Admit(t.Context(), stranger, Batch(t, SourceID(1), 1, "", Record(0)), received, sdktelemetry.Stamp{}); !errors.Is(err, telemetrydelivery.ErrParticipantGone) {
		t.Fatalf("err = %v, want ErrParticipantGone", err)
	}
	if rows := episode(t, world, live); len(rows) != 0 {
		t.Fatalf("rows = %+v, want none", rows)
	}
}

func purgeFence(t *testing.T, world World) {
	owner := world.Join(t, 0)
	mustAdmit(t, world, owner, Batch(t, SourceID(1), 1, "", Record(0)))
	if err := world.Ledger().Live(t.Context(), owner); err != nil {
		t.Fatalf("before the purge: live err = %v, want nil", err)
	}
	world.Purge(t)
	if err := world.Ledger().Live(t.Context(), owner); !errors.Is(err, telemetrydelivery.ErrParticipantGone) {
		t.Fatalf("after the purge: live err = %v, want ErrParticipantGone", err)
	}
	for _, request := range []sdktelemetry.Request{Batch(t, SourceID(1), 2, "", Record(1)), Batch(t, SourceID(2), 1, "", Record(0))} {
		if _, err := world.Ledger().Admit(t.Context(), owner, request, received, sdktelemetry.Stamp{}); !errors.Is(err, telemetrydelivery.ErrParticipantGone) {
			t.Fatalf("after the purge: err = %v, want ErrParticipantGone", err)
		}
	}
	if rows := episode(t, world, owner); len(rows) != 0 {
		t.Fatalf("after the purge: rows = %+v, want none recreated", rows)
	}
}

func sourceBudget(t *testing.T, world World) {
	owner, other := world.Join(t, 0), world.Join(t, 0)
	for index := range telemetrydelivery.MaxSourcesPerParticipant {
		mustAdmit(t, world, owner, Batch(t, SourceID(index+1), 1, "", Record(0)))
	}
	next := SourceID(telemetrydelivery.MaxSourcesPerParticipant + 1)
	if _, err := world.Ledger().Admit(t.Context(), owner, Batch(t, next, 0, "closed"), received, sdktelemetry.Stamp{}); !errors.Is(err, telemetrydelivery.ErrSourceBudget) {
		t.Fatalf("a source past the budget: err = %v, want ErrSourceBudget", err)
	}
	if rows := episode(t, world, owner); len(rows) != telemetrydelivery.MaxSourcesPerParticipant {
		t.Fatalf("rows = %d, want %d", len(rows), telemetrydelivery.MaxSourcesPerParticipant)
	}
	mustAdmit(t, world, owner, Batch(t, SourceID(1), 2, "closed", Record(1)))
	mustAdmit(t, world, other, Batch(t, next, 0, "closed"))
}

// A User keeps one participant per Episode, and every page load starts a new source, so a long
// call with a few dozen reloads must not run into the source budget.
func manyReloads(t *testing.T, world World) {
	owner := world.Join(t, 0)
	const loads = 24
	for index := range loads {
		if _, err := world.Ledger().Admit(t.Context(), owner, Batch(t, SourceID(index+1), 1, "closed", Record(0)), received, sdktelemetry.Stamp{}); err != nil {
			t.Fatalf("page load %d: err = %v, want it admitted", index+1, err)
		}
	}
	if rows := episode(t, world, owner); len(rows) != loads {
		t.Fatalf("rows = %d, want %d", len(rows), loads)
	}
}

func emptyClose(t *testing.T, world World) {
	owner := world.Join(t, 0)
	mustAdmit(t, world, owner, Batch(t, SourceID(1), 0, "closed"))
	rows := episode(t, world, owner)
	if len(rows) != 1 || rows[0].End != telemetrydelivery.EndClosed {
		t.Fatalf("rows = %+v after an empty close of a fresh source, want one closed row", rows)
	}
}

func shortClose(t *testing.T, world World) {
	owner := world.Join(t, 0)
	mustAdmit(t, world, owner, Batch(t, SourceID(1), 5, "", Record(0), Record(1)))
	short := mustAdmit(t, world, owner, Batch(t, SourceID(1), 2, "closed"))
	if short.EndRejection != telemetrydelivery.ReasonEndShort {
		t.Fatalf("end rejection = %q, want %q", short.EndRejection, telemetrydelivery.ReasonEndShort)
	}
	gaps, mark := telemetrydelivery.Gaps(source(t, world, owner, SourceID(1)))
	if mark.End != nil || len(gaps) != 2 || gaps[0].Cause != telemetrydelivery.GapMissing || gaps[0].FromSeq != 2 || *gaps[0].ToSeq != 5 {
		t.Fatalf("gaps = %+v, end = %v after a close at 2 below the reported 5, want [2,5) missing and no end", gaps, mark.End)
	}
	exact := mustAdmit(t, world, owner, Batch(t, SourceID(1), 5, "closed"))
	if exact.EndRejection != "" {
		t.Fatalf("a close at the reported next_seq was refused: %q", exact.EndRejection)
	}
	if conflict := mustAdmit(t, world, owner, Batch(t, SourceID(1), 7, "closed")); conflict.EndRejection != telemetrydelivery.ReasonEndConflict {
		t.Fatalf("a second close at another next_seq: rejection = %q, want %q", conflict.EndRejection, telemetrydelivery.ReasonEndConflict)
	}
}

func rejectedGap(t *testing.T, world World) {
	owner := world.Join(t, 0)
	bad := strings.Replace(Record(1), `"left"`, `"nope"`, 1)
	admission := mustAdmit(t, world, owner, Batch(t, SourceID(1), 3, "closed", Record(0), bad, Record(2)))
	if !reflect.DeepEqual(admission.Settled, telemetrydelivery.NewSet(sdktelemetry.SeqRange{From: 0, To: 3})) {
		t.Fatalf("settled = %v, want the rejected seq settled with the rest", admission.Settled)
	}
	gaps, _ := telemetrydelivery.Gaps(source(t, world, owner, SourceID(1)))
	if len(gaps) != 1 || gaps[0].Cause != telemetrydelivery.GapRejected || gaps[0].FromSeq != 1 {
		t.Fatalf("gaps = %+v, want the rejected seq 1 as the only gap of the closed source", gaps)
	}
}

func mustAdmit(t *testing.T, world World, identity telemetrydelivery.Identity, request sdktelemetry.Request) telemetrydelivery.Admission {
	t.Helper()
	admission, err := world.Ledger().Admit(t.Context(), identity, request, received, sdktelemetry.Stamp{})
	if err != nil {
		t.Fatalf("Admit: %v", err)
	}
	return admission
}

func source(t *testing.T, world World, identity telemetrydelivery.Identity, id utilities.ID) telemetrydelivery.SourceRow {
	t.Helper()
	row, found, err := world.Ledger().Source(t.Context(), identity.TenantID, id)
	if err != nil || !found {
		t.Fatalf("source %s: found = %v, err = %v", id, found, err)
	}
	return row
}

func episode(t *testing.T, world World, identity telemetrydelivery.Identity) []telemetrydelivery.SourceRow {
	t.Helper()
	rows, err := world.Ledger().Episode(t.Context(), identity.TenantID, identity.EpisodeID)
	if err != nil {
		t.Fatal(err)
	}
	return rows
}

// SourceID is the nth test source id.
func SourceID(n int) utilities.ID {
	id, err := utilities.ParseID(fmt.Sprintf("0b7c0000-0000-4000-8000-%012d", n))
	if err != nil {
		panic(err)
	}
	return id
}

// Record is a valid record at seq.
func Record(seq int64) string {
	return fmt.Sprintf(`{"event_id":"9a4f0000-0000-4000-8000-%012d","seq":%d,"elapsed_ms":1,"type":"call_ended","end_reason":"left"}`, seq, seq)
}

// Batch is a decoded version 2 batch of the source.
func Batch(t *testing.T, source utilities.ID, nextSeq int64, end string, events ...string) sdktelemetry.Request {
	t.Helper()
	endField := ""
	if end != "" {
		endField = fmt.Sprintf(`,"end":%q`, end)
	}
	body := fmt.Sprintf(`{"version":2,"source_id":%q,"batch_id":"5d1e0000-0000-4000-8000-000000000001","next_seq":%d%s,"events":[%s]}`, source, nextSeq, endField, strings.Join(events, ","))
	request, frame := sdktelemetry.Decode(strings.NewReader(body))
	if frame != "" {
		t.Fatalf("batch frame refused: %s", frame)
	}
	return request
}
