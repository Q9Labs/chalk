package postgres

import (
	"context"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/sdktelemetry"
	"github.com/q9labs/chalk/apps/api/internal/telemetrydelivery"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func telemetryLedgerPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("CHALK_TELEMETRY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("CHALK_TELEMETRY_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	return pool
}

type telemetryProof struct {
	t        *testing.T
	pool     *pgxpool.Pool
	ledger   TelemetryLedger
	identity telemetrydelivery.Identity
}

func newTelemetryProof(t *testing.T) telemetryProof {
	t.Helper()
	pool := telemetryLedgerPool(t)
	identity := telemetrydelivery.Identity{TenantID: accountTenantIntegrationID(t), EpisodeID: accountTenantIntegrationID(t), ParticipantID: accountTenantIntegrationID(t)}
	t.Cleanup(func() {
		mustExec(t, pool, `delete from telemetry_sources where tenant_id = $1`, uuid(identity.TenantID))
		mustExec(t, pool, `delete from telemetry_source_bindings where tenant_id = $1`, uuid(identity.TenantID))
	})
	return telemetryProof{t: t, pool: pool, ledger: NewTelemetryLedger(pool), identity: identity}
}

func telemetryEvent(seq int64) string {
	return fmt.Sprintf(`{"event_id":"9a4f0000-0000-4000-8000-%012d","seq":%d,"elapsed_ms":1,"type":"call_ended","end_reason":"left"}`, seq, seq)
}

func telemetryBatch(t *testing.T, source string, nextSeq int64, end string, events ...string) sdktelemetry.Request {
	t.Helper()
	endField := ""
	if end != "" {
		endField = fmt.Sprintf(`,"end":%q`, end)
	}
	body := fmt.Sprintf(`{"version":2,"source_id":%q,"batch_id":"5d1e0000-0000-4000-8000-000000000001","next_seq":%d%s,"events":[%s]}`, source, nextSeq, endField, strings.Join(events, ","))
	request, frame := sdktelemetry.Decode(strings.NewReader(body))
	if frame != "" {
		t.Fatalf("frame refused: %s", frame)
	}
	return request
}

const (
	proofSource      = "0b7c0000-0000-4000-8000-00000000000a"
	proofPredecessor = "0b7c0000-0000-4000-8000-00000000000b"
)

// newSeqs returns the seqs of the records an admission calls new.
func newSeqs(admission telemetrydelivery.Admission) []int64 {
	seqs := []int64{}
	for _, event := range admission.New {
		seqs = append(seqs, event.Seq)
	}
	return seqs
}

func (p telemetryProof) admit(request sdktelemetry.Request, write telemetrydelivery.SinkWrite) (telemetrydelivery.Admission, error) {
	return p.ledger.Admit(p.t.Context(), p.identity, request, time.Now(), write)
}

func (p telemetryProof) rows(source string) []telemetrydelivery.SourceRow {
	p.t.Helper()
	id, err := utilities.ParseID(source)
	if err != nil {
		p.t.Fatal(err)
	}
	rows, err := p.ledger.Source(p.t.Context(), p.identity.TenantID, id)
	if err != nil {
		p.t.Fatal(err)
	}
	return rows
}

func TestTelemetryLedgerSettlesABatchOnceAndAnswersARetryWithDuplicates(t *testing.T) {
	proof := newTelemetryProof(t)
	request := telemetryBatch(t, proofSource, 3, "", telemetryEvent(0), telemetryEvent(1), telemetryEvent(2))
	var wrote [][]int64
	write := func(_ context.Context, admission telemetrydelivery.Admission) error {
		wrote = append(wrote, newSeqs(admission))
		return nil
	}
	for range 2 {
		if _, err := proof.admit(request, write); err != nil {
			t.Fatal(err)
		}
	}
	if want := [][]int64{{0, 1, 2}, {}}; !reflect.DeepEqual(wrote, want) {
		t.Fatalf("sink writes = %v, want %v", wrote, want)
	}
	rows := proof.rows(proofSource)
	if len(rows) != 1 || !reflect.DeepEqual(rows[0].Ranges.Stored, telemetrydelivery.NewSet(sdktelemetry.SeqRange{From: 0, To: 3})) || rows[0].ReportedNextSeq != 3 || rows[0].End != telemetrydelivery.EndNone {
		t.Fatalf("rows = %+v, want one row with seqs [0,3) stored and no end", rows)
	}
	byEpisode, err := proof.ledger.Episode(t.Context(), proof.identity.TenantID, proof.identity.EpisodeID)
	if err != nil || len(byEpisode) != 1 {
		t.Fatalf("Episode rows = %v, %v, want the one source", byEpisode, err)
	}
	if gaps, _ := telemetrydelivery.Gaps(rows); len(gaps) != 1 || gaps[0].Cause != telemetrydelivery.GapTailUnknown || gaps[0].ToSeq != nil {
		t.Fatalf("gaps = %+v, want only the open tail", gaps)
	}
}

// A crash between the sink write and the commit leaves the ledger as it was, so the retry finds
// its records new and writes the sink rows again.
func TestTelemetryLedgerCrashBetweenSinkAndCommitLeavesTheRowUnchanged(t *testing.T) {
	proof := newTelemetryProof(t)
	if _, err := proof.admit(telemetryBatch(t, proofSource, 2, "", telemetryEvent(0), telemetryEvent(1)), func(context.Context, telemetrydelivery.Admission) error { return nil }); err != nil {
		t.Fatal(err)
	}
	before := proof.rows(proofSource)

	crash := errors.New("crash after the sink write")
	request := telemetryBatch(t, proofSource, 5, "closed", telemetryEvent(2), telemetryEvent(3), telemetryEvent(4))
	sunk := 0
	_, err := proof.admit(request, func(_ context.Context, admission telemetrydelivery.Admission) error {
		sunk = len(admission.New)
		return crash
	})
	if !errors.Is(err, crash) || sunk != 3 {
		t.Fatalf("error = %v, sink rows = %d, want the crash after 3 sink rows", err, sunk)
	}
	if after := proof.rows(proofSource); !reflect.DeepEqual(after, before) {
		t.Fatalf("row after the crash = %+v, want it unchanged: %+v", after, before)
	}

	var again []int64
	admission, err := proof.admit(request, func(_ context.Context, admission telemetrydelivery.Admission) error {
		again = newSeqs(admission)
		return nil
	})
	if err != nil || !reflect.DeepEqual(again, []int64{2, 3, 4}) || admission.Duplicates != 0 {
		t.Fatalf("retry: new = %v, duplicates = %d, err = %v, want the same 3 records written again", again, admission.Duplicates, err)
	}
	if rows := proof.rows(proofSource); rows[0].End != telemetrydelivery.EndClosed || rows[0].EndNextSeq != 5 {
		t.Fatalf("row = %+v, want the closed end committed with the retry", rows[0])
	}
}

// Two batches of one source queue behind the row lock: the second sees the first's commit.
func TestTelemetryLedgerRowLockMakesConcurrentRetriesDuplicates(t *testing.T) {
	proof := newTelemetryProof(t)
	request := telemetryBatch(t, proofSource, 2, "", telemetryEvent(0), telemetryEvent(1))
	inSink, release := make(chan struct{}), make(chan struct{})
	first := make(chan error, 1)
	go func() {
		_, err := proof.admit(request, func(context.Context, telemetrydelivery.Admission) error {
			close(inSink)
			<-release
			return nil
		})
		first <- err
	}()
	<-inSink

	var secondWroteNew atomic.Int64
	second := make(chan telemetrydelivery.Admission, 1)
	secondErr := make(chan error, 1)
	go func() {
		admission, err := proof.admit(request, func(_ context.Context, admission telemetrydelivery.Admission) error {
			secondWroteNew.Store(int64(len(admission.New)) + 1)
			return nil
		})
		second <- admission
		secondErr <- err
	}()
	time.Sleep(500 * time.Millisecond)
	if secondWroteNew.Load() != 0 {
		t.Fatal("the second batch reached the sink while the first held the row lock")
	}
	close(release)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	admission := <-second
	if err := <-secondErr; err != nil {
		t.Fatal(err)
	}
	if admission.Duplicates != 2 || len(admission.New) != 0 || secondWroteNew.Load() != 1 {
		t.Fatalf("second batch: duplicates = %d, new = %d, want 2 duplicates and nothing new after waiting for the first commit", admission.Duplicates, len(admission.New))
	}
}

// A reload is a new source, so its seq 0 is new.
func TestTelemetryLedgerKeysRowsBySource(t *testing.T) {
	proof := newTelemetryProof(t)
	noSink := func(context.Context, telemetrydelivery.Admission) error { return nil }
	if _, err := proof.admit(telemetryBatch(t, proofSource, 1, "", telemetryEvent(0)), noSink); err != nil {
		t.Fatal(err)
	}
	reloaded := telemetryBatch(t, proofPredecessor, 1, "", telemetryEvent(0))
	admission, err := proof.admit(reloaded, noSink)
	if err != nil || admission.Duplicates != 0 || len(admission.New) != 1 {
		t.Fatalf("a new source's seq 0: duplicates = %d, new = %d, err = %v, want it stored", admission.Duplicates, len(admission.New), err)
	}
}

type telemetryBinding struct {
	participant utilities.ID
	identity    utilities.ID
	boundAt     time.Time
}

func (p telemetryProof) bindings() map[string]telemetryBinding {
	p.t.Helper()
	rows, err := p.ledger.db.Query(p.t.Context(), `select source_id, participant_id, identity_id, bound_at from telemetry_source_bindings where tenant_id = $1`, uuid(p.identity.TenantID))
	if err != nil {
		p.t.Fatal(err)
	}
	defer rows.Close()
	bound := map[string]telemetryBinding{}
	for rows.Next() {
		var source, participant, identity pgtype.UUID
		var boundAt pgtype.Timestamptz
		if err := rows.Scan(&source, &participant, &identity, &boundAt); err != nil {
			p.t.Fatal(err)
		}
		bound[nullableID(source).String()] = telemetryBinding{nullableID(participant), nullableID(identity), boundAt.Time}
	}
	if err := rows.Err(); err != nil {
		p.t.Fatal(err)
	}
	return bound
}

// A batch binds its own source and every predecessor it names to its participant, as a guest when
// the participant has no row.
func TestTelemetryLedgerBindsEverySourceABatchTouches(t *testing.T) {
	proof := newTelemetryProof(t)
	drop := fmt.Sprintf(`{"event_id":"9a4f0000-0000-4000-8000-%012d","seq":0,"elapsed_ms":1,"type":"telemetry_dropped","dropped":4,"drop_reason":"queue_full","dropped_seqs":[{"from":6,"to":10}],"dropped_source_id":%q}`, 0, proofPredecessor)
	received := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	if _, err := proof.ledger.Admit(t.Context(), proof.identity, telemetryBatch(t, proofSource, 1, "", drop), received, func(context.Context, telemetrydelivery.Admission) error { return nil }); err != nil {
		t.Fatal(err)
	}
	bound := proof.bindings()
	for _, source := range []string{proofSource, proofPredecessor} {
		binding, found := bound[source]
		if !found || binding.participant != proof.identity.ParticipantID || !binding.identity.IsZero() || !binding.boundAt.Equal(received) {
			t.Fatalf("binding of %s = %+v, %v, want the batch's participant as a guest bound at %s", source, binding, found, received)
		}
	}
	if len(bound) != 2 {
		t.Fatalf("bindings = %v, want the two sources", bound)
	}
}

// Another participant of the tenant that knows a source_id cannot add records, a close or drop
// claims to it: the whole batch is refused before the sink, and the victim's rows, gaps and
// bindings stay as they were.
func TestTelemetryLedgerRefusesAnotherParticipantAndLeavesTheVictimAlone(t *testing.T) {
	victim := newTelemetryProof(t)
	noSink := func(context.Context, telemetrydelivery.Admission) error { return nil }
	if _, err := victim.admit(telemetryBatch(t, proofSource, 4, "", telemetryEvent(0)), noSink); err != nil {
		t.Fatal(err)
	}
	before, bindingsBefore := victim.rows(proofSource), victim.bindings()
	gapsBefore, _ := telemetrydelivery.Gaps(before)

	hostile := victim
	hostile.identity.ParticipantID = accountTenantIntegrationID(t)
	hostileSource := "0b7c0000-0000-4000-8000-00000000000c"
	drop := fmt.Sprintf(`{"event_id":"9a4f0000-0000-4000-8000-%012d","seq":0,"elapsed_ms":1,"type":"telemetry_dropped","dropped":3,"drop_reason":"queue_full","dropped_seqs":[{"from":1,"to":4}],"dropped_source_id":%q}`, 0, proofSource)
	for _, attack := range []sdktelemetry.Request{
		telemetryBatch(t, proofSource, 4, "closed", telemetryEvent(1), telemetryEvent(2), telemetryEvent(3)),
		telemetryBatch(t, hostileSource, 1, "", drop),
	} {
		sunk := false
		_, err := hostile.admit(attack, func(context.Context, telemetrydelivery.Admission) error {
			sunk = true
			return nil
		})
		if !errors.Is(err, telemetrydelivery.ErrSourceBound) || sunk {
			t.Fatalf("hostile batch: err = %v, sink written = %v, want ErrSourceBound before the sink", err, sunk)
		}
	}
	after := victim.rows(proofSource)
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("victim rows = %+v, want them unchanged: %+v", after, before)
	}
	if gaps, _ := telemetrydelivery.Gaps(after); !reflect.DeepEqual(gaps, gapsBefore) || len(gaps) != 2 || gaps[0].Cause != telemetrydelivery.GapMissing {
		t.Fatalf("victim gaps = %+v, want them unchanged with [1,4) missing: %+v", gaps, gapsBefore)
	}
	if bound := victim.bindings(); !reflect.DeepEqual(bound, bindingsBefore) {
		t.Fatalf("bindings = %v, want only the victim's: %v", bound, bindingsBefore)
	}
	if rows := victim.rows(hostileSource); len(rows) != 0 {
		t.Fatalf("hostile source rows = %v, want none from a refused batch", rows)
	}
}

// seedTelemetryParticipants creates a tenant with one Episode and returns participants of it: two
// of the same User, one of another User and a guest. Everything lives in tx and is rolled back.
func seedTelemetryParticipants(t *testing.T, tx pgx.Tx) (tenant, episode utilities.ID, first, successor, stranger, guest utilities.ID) {
	t.Helper()
	ctx := t.Context()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(ctx, query, args...); err != nil {
			t.Fatalf("seed %q: %v", query, err)
		}
	}
	tenant, space, episode := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	exec(`insert into tenants(id, name) values($1, 'Telemetry bindings')`, uuid(tenant))
	exec(`insert into spaces(id, name, tenant_id, slug, media_plane) values($1, 'Telemetry bindings', $2, $3, 'cf_sfu')`, uuid(space), uuid(tenant), "telemetry-bindings-"+space.String())
	exec(`insert into episodes(id, status, space_id, tenant_id, config_snapshot) values($1, 'active', $2, $3, '{"media_plane_binding":{"provider":"cf_sfu"}}'::jsonb)`, uuid(episode), uuid(space), uuid(tenant))
	user, other := accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	for _, identity := range []utilities.ID{user, other} {
		exec(`insert into identities(id, tenant_id, kind, external_id, display_name) values($1, $2, 'user', $3, 'Telemetry')`, uuid(identity), uuid(tenant), identity.String())
	}
	participant := func(identity utilities.ID) utilities.ID {
		id := accountTenantIntegrationID(t)
		exec(`insert into participants(id, tenant_id, space_id, episode_id, identity_id, capabilities, generation, status, role) values($1, $2, $3, $4, $5, '{subscribe}'::text[], 1, 'left', 'collaborator')`, uuid(id), uuid(tenant), uuid(space), uuid(episode), uuid(identity))
		return id
	}
	return tenant, episode, participant(user), participant(user), participant(other), participant(utilities.ID{})
}

// The same User rejoined is a new participant of the same identity, so it may write to the source
// its earlier participant bound; its copy of a seq is new, not a duplicate, because rows are keyed
// by participant. A participant of another User and a guest are refused.
func TestTelemetryLedgerAcceptsASuccessorOfTheSameIdentityOnly(t *testing.T) {
	pool := telemetryLedgerPool(t)
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	tenant, episode, first, successor, stranger, guest := seedTelemetryParticipants(t, tx)
	proof := telemetryProof{t: t, pool: pool, ledger: NewTelemetryLedger(tx), identity: telemetrydelivery.Identity{TenantID: tenant, EpisodeID: episode, ParticipantID: first}}
	noSink := func(context.Context, telemetrydelivery.Admission) error { return nil }

	one := telemetryBatch(t, proofSource, 1, "", telemetryEvent(0))
	if _, err := proof.admit(one, noSink); err != nil {
		t.Fatal(err)
	}
	if binding := proof.bindings()[proofSource]; binding.participant != first || binding.identity.IsZero() {
		t.Fatalf("binding = %+v, want the first participant with its identity", binding)
	}
	next := proof
	next.identity.ParticipantID = successor
	admission, err := next.admit(one, noSink)
	if err != nil || admission.Duplicates != 0 || len(admission.New) != 1 {
		t.Fatalf("the successor's copy: duplicates = %d, new = %d, err = %v, want it stored", admission.Duplicates, len(admission.New), err)
	}
	if rows := proof.rows(proofSource); len(rows) != 2 {
		t.Fatalf("rows of the source = %d, want one per participant", len(rows))
	}
	for name, participant := range map[string]utilities.ID{"another User": stranger, "a guest": guest} {
		refused := proof
		refused.identity.ParticipantID = participant
		if _, err := refused.admit(telemetryBatch(t, proofSource, 2, "closed", telemetryEvent(1)), noSink); !errors.Is(err, telemetrydelivery.ErrSourceBound) {
			t.Fatalf("%s: err = %v, want ErrSourceBound", name, err)
		}
	}
}

// Two first batches of one new source from different participants: the second waits on the
// first's uncommitted binding, then finds it and is refused, so the source has exactly one binding.
func TestTelemetryLedgerConcurrentFirstBatchesBindTheSourceOnce(t *testing.T) {
	proof := newTelemetryProof(t)
	other := proof
	other.identity.ParticipantID = accountTenantIntegrationID(t)
	request := telemetryBatch(t, proofSource, 1, "", telemetryEvent(0))
	inSink, release := make(chan struct{}), make(chan struct{})
	first := make(chan error, 1)
	go func() {
		_, err := proof.admit(request, func(context.Context, telemetrydelivery.Admission) error {
			close(inSink)
			<-release
			return nil
		})
		first <- err
	}()
	<-inSink

	var secondSunk atomic.Bool
	second := make(chan error, 1)
	go func() {
		_, err := other.admit(request, func(context.Context, telemetrydelivery.Admission) error {
			secondSunk.Store(true)
			return nil
		})
		second <- err
	}()
	select {
	case err := <-second:
		t.Fatalf("the second batch finished (%v) while the first held its uncommitted binding", err)
	case <-time.After(500 * time.Millisecond):
	}
	close(release)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	if err := <-second; !errors.Is(err, telemetrydelivery.ErrSourceBound) || secondSunk.Load() {
		t.Fatalf("second batch: err = %v, sink written = %v, want ErrSourceBound before the sink", err, secondSunk.Load())
	}
	var count int
	if err := proof.pool.QueryRow(t.Context(), `select count(*) from telemetry_source_bindings where tenant_id = $1 and source_id = $2`, uuid(proof.identity.TenantID), uuidString(proofSource)).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if binding := proof.bindings()[proofSource]; count != 1 || binding.participant != proof.identity.ParticipantID {
		t.Fatalf("bindings = %d, binding = %+v, want exactly one, of the first participant", count, binding)
	}
}

func TestTelemetryLedgerAppliesAPredecessorDropToItsRow(t *testing.T) {
	proof := newTelemetryProof(t)
	drop := fmt.Sprintf(`{"event_id":"9a4f0000-0000-4000-8000-%012d","seq":0,"elapsed_ms":1,"type":"telemetry_dropped","dropped":4,"drop_reason":"queue_full","dropped_seqs":[{"from":6,"to":10}],"dropped_source_id":%q}`, 0, proofPredecessor)
	if _, err := proof.admit(telemetryBatch(t, proofSource, 1, "", drop), func(context.Context, telemetrydelivery.Admission) error { return nil }); err != nil {
		t.Fatal(err)
	}
	rows := proof.rows(proofPredecessor)
	if len(rows) != 1 || !reflect.DeepEqual(rows[0].Ranges.Dropped["queue_full"], telemetrydelivery.NewSet(sdktelemetry.SeqRange{From: 6, To: 10})) {
		t.Fatalf("predecessor rows = %+v, want its dropped range named", rows)
	}
	if rows[0].EpisodeID != proof.identity.EpisodeID {
		t.Fatalf("predecessor episode = %s, want the batch's", rows[0].EpisodeID)
	}
}
