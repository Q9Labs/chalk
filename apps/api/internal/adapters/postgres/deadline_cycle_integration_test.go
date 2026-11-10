package postgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// savepointTransactor keeps the scheduler's transactions inside one outer
// transaction that the test rolls back, so nothing is committed.
type savepointTransactor struct{ outer pgx.Tx }

func (t savepointTransactor) BeginTx(ctx context.Context, _ pgx.TxOptions) (pgx.Tx, error) {
	return t.outer.Begin(ctx)
}

type schedulerEpisode struct {
	tenantID, spaceID, episodeID utilities.ID
	participants                 []utilities.ID
}

type schedulerFixture struct {
	t   *testing.T
	ctx context.Context
	tx  pgx.Tx
}

// newSchedulerFixture opens the outer transaction and plays the Sync session
// the scheduler waits for: the advisory locks that mark presence recovery as
// finished, and a recovery time in the past.
func newSchedulerFixture(t *testing.T) schedulerFixture {
	t.Helper()
	if testing.Short() {
		t.Skip("postgres integration")
	}
	databaseURL := os.Getenv("CHALK_SYNC_OVERHAUL_TEST_DATABASE_URL")
	if databaseURL == "" {
		databaseURL = os.Getenv(config.DatabaseURL)
	}
	if databaseURL == "" {
		databaseURL = config.DefaultDatabaseURL
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	syncSession, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(syncSession.Release)
	for _, objectID := range []int{1, 2} {
		if _, err := syncSession.Exec(ctx, `select pg_advisory_lock_shared(1128811595, $1)`, objectID); err != nil {
			t.Fatalf("hold presence recovery lock %d: %v", objectID, err)
		}
	}
	t.Cleanup(func() { _, _ = syncSession.Exec(context.Background(), `select pg_advisory_unlock_all()`) })
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	fixture := schedulerFixture{t: t, ctx: ctx, tx: tx}
	fixture.exec(`update sync_presence_runtime set recover_after = clock_timestamp() - interval '1 hour'`)
	return fixture
}

func (f schedulerFixture) exec(query string, args ...any) {
	f.t.Helper()
	if _, err := f.tx.Exec(f.ctx, query, args...); err != nil {
		f.t.Fatalf("seed %q: %v", query, err)
	}
}

func (f schedulerFixture) count(query string, args ...any) int {
	f.t.Helper()
	var count int
	if err := f.tx.QueryRow(f.ctx, query, args...).Scan(&count); err != nil {
		f.t.Fatalf("count %q: %v", query, err)
	}
	return count
}

// episode seeds an active Episode started an hour ago in its own Space with
// activeParticipants. A participant's presence lease expires as an hour-old
// join would, or an hour from now when leasesExpired is false.
func (f schedulerFixture) episode(deadline string, activeParticipants int, leasesExpired bool) schedulerEpisode {
	f.t.Helper()
	episode := schedulerEpisode{tenantID: accountTenantIntegrationID(f.t), spaceID: accountTenantIntegrationID(f.t), episodeID: accountTenantIntegrationID(f.t)}
	f.exec(`insert into tenants(id, name) values($1, 'Deadline scheduler regression')`, episode.tenantID.Bytes())
	f.exec(`insert into spaces(id, name, tenant_id, slug, media_plane) values($1, 'Deadline scheduler regression', $2, $3, 'cf_sfu')`, episode.spaceID.Bytes(), episode.tenantID.Bytes(), "deadline-cycle-"+episode.spaceID.String())
	f.exec(`insert into episodes(id, status, space_id, tenant_id, config_snapshot, started_at, created_at, deadline_at) values($1, 'active', $2, $3, '{}'::jsonb, now() - interval '1 hour', now() - interval '1 hour', `+deadline+`)`, episode.episodeID.Bytes(), episode.spaceID.Bytes(), episode.tenantID.Bytes())
	f.exec(`insert into sync_episode_control(tenant_id, space_id, episode_id, folded_state, state_schema_version, state_digest, snapshot_bytes) values($1, $2, $3, '{}'::jsonb, 1, $4, 2)`, episode.tenantID.Bytes(), episode.spaceID.Bytes(), episode.episodeID.Bytes(), make([]byte, 32))
	leaseExpiry := `now() + interval '1 hour'`
	if leasesExpired {
		leaseExpiry = `now() - interval '30 minutes'`
		f.exec(`insert into episode_presence_leases(tenant_id, space_id, episode_id, expires_at) values($1, $2, $3, `+leaseExpiry+`)`, episode.tenantID.Bytes(), episode.spaceID.Bytes(), episode.episodeID.Bytes())
	}
	for range activeParticipants {
		participantID := accountTenantIntegrationID(f.t)
		episode.participants = append(episode.participants, participantID)
		f.exec(`insert into participants(id, tenant_id, space_id, episode_id, capabilities, generation, status, role, joined_at) values($1, $2, $3, $4, '{publishAudio}', 1, 'active', 'collaborator', now() - interval '1 hour')`, participantID.Bytes(), episode.tenantID.Bytes(), episode.spaceID.Bytes(), episode.episodeID.Bytes())
		f.exec(`insert into participant_presence_leases(tenant_id, space_id, episode_id, participant_id, generation, expires_at) values($1, $2, $3, $4, 1, `+leaseExpiry+`)`, episode.tenantID.Bytes(), episode.spaceID.Bytes(), episode.episodeID.Bytes(), participantID.Bytes())
	}
	return episode
}

// leftParticipants adds participants who already left, as the real Episode had
// before its last two attendees stopped sending heartbeats.
func (f schedulerFixture) leftParticipants(e schedulerEpisode, count int) {
	f.t.Helper()
	for range count {
		f.exec(`insert into participants(id, tenant_id, space_id, episode_id, capabilities, generation, status, role, joined_at, left_at) values($1, $2, $3, $4, '{publishAudio}', 1, 'left', 'collaborator', now() - interval '1 hour', now() - interval '55 minutes')`,
			accountTenantIntegrationID(f.t).Bytes(), e.tenantID.Bytes(), e.spaceID.Bytes(), e.episodeID.Bytes())
	}
}

// blockedEpisode seeds an Episode past its deadline whose participant has an
// unexpired publication fence owned by another operation.
func (f schedulerFixture) blockedEpisode(deadline string) (schedulerEpisode, utilities.ID) {
	f.t.Helper()
	blocked := f.episode(deadline, 1, false)
	foreignOperationID := accountTenantIntegrationID(f.t)
	f.exec(`insert into sync_external_operations(tenant_id, space_id, episode_id, external_operation_id, request_key, request_fingerprint, operation_name, target_participant_id, target_participant_generation, payload) values($1, $2, $3, $4, 'foreign_leave_request', $5, 'participant_leave', $6, 1, '{}'::jsonb)`,
		blocked.tenantID.Bytes(), blocked.spaceID.Bytes(), blocked.episodeID.Bytes(), foreignOperationID.Bytes(), make([]byte, 32), blocked.participants[0].Bytes())
	f.exec(`insert into sync_publication_fences(tenant_id, space_id, episode_id, participant_id, participant_generation, source, external_operation_id, expires_at) values($1, $2, $3, $4, 1, 'microphone', $5, now() + interval '5 minutes')`,
		blocked.tenantID.Bytes(), blocked.spaceID.Bytes(), blocked.episodeID.Bytes(), blocked.participants[0].Bytes(), foreignOperationID.Bytes())
	return blocked, foreignOperationID
}

func (f schedulerFixture) operations(e schedulerEpisode, operationName string) int {
	f.t.Helper()
	return f.count(`select count(*) from sync_external_operations where tenant_id=$1 and episode_id=$2 and operation_name=$3`, e.tenantID.Bytes(), e.episodeID.Bytes(), operationName)
}

func (f schedulerFixture) run() episodes.DeadlineCycle {
	f.t.Helper()
	return f.runWithBatch(500)
}

func (f schedulerFixture) runWithBatch(batch int32) episodes.DeadlineCycle {
	f.t.Helper()
	repository := NewEpisodeLifecycleRepository(savepointTransactor{outer: f.tx})
	cycle, err := repository.EnqueueDueEpisodeDeadlines(f.ctx, batch)
	if err != nil {
		f.t.Fatalf("deadline scheduler cycle: %v", err)
	}
	return cycle
}

func (c schedulerFixture) skippedFor(cycle episodes.DeadlineCycle, e schedulerEpisode) []episodes.SkippedEpisode {
	var skipped []episodes.SkippedEpisode
	for _, candidate := range cycle.Skipped {
		if candidate.EpisodeID == e.episodeID {
			skipped = append(skipped, candidate)
		}
	}
	return skipped
}

// Shape of a nightly Episode (observed 2026-11-08) that stopped every deadline: a 24 hour
// Episode with two participants already left and two still active, their
// presence leases and the Episode lease expired, linger window 0, and the
// control row holding reserved events and intents.
// The presence phase fences the participants, and the linger phase then tried
// to take the same fences, failed with control busy and rolled back the pass.
func TestDeadlineCycleExpiredPresenceDoesNotRollBackOtherEpisodes(t *testing.T) {
	f := newSchedulerFixture(t)
	abandoned := f.episode(`now() + interval '24 hours'`, 2, true)
	f.leftParticipants(abandoned, 2)
	f.exec(`update sync_episode_control set lifecycle_reserved_events=5, lifecycle_reserved_intents=5 where episode_id=$1`, abandoned.episodeID.Bytes())
	due := f.episode(`now() - interval '1 second'`, 1, false)

	cycle := f.run()

	if skipped := f.skippedFor(cycle, abandoned); len(skipped) != 0 {
		t.Fatalf("abandoned Episode was skipped: %+v", skipped)
	}
	if got := f.operations(abandoned, "participant_leave"); got != 2 {
		t.Fatalf("presence expiry created %d leave operations, want 2", got)
	}
	if got := f.count(`select count(*) from sync_publication_fences fence join sync_external_operations o on o.external_operation_id=fence.external_operation_id where fence.episode_id=$1 and o.operation_name='participant_leave'`, abandoned.episodeID.Bytes()); got != 6 {
		t.Fatalf("leave operations own %d fences, want 6", got)
	}
	if got := f.operations(abandoned, "tenant_end_episode"); got != 0 {
		t.Fatalf("linger ended the Episode in the same pass as its leave operations: %d end operations", got)
	}
	if got := f.operations(due, "maximum_episode_duration_expired"); got != 1 {
		t.Fatalf("Episode past its deadline got %d deadline operations, want 1: another Episode's failure rolled it back", got)
	}

	// Sync applies the leave operations and releases their fences.
	f.exec(`delete from sync_publication_fences where episode_id=$1`, abandoned.episodeID.Bytes())
	f.exec(`update participants set status='left', left_at=now() where episode_id=$1`, abandoned.episodeID.Bytes())
	cycle = f.run()
	if skipped := f.skippedFor(cycle, abandoned); len(skipped) != 0 {
		t.Fatalf("abandoned Episode was skipped after its participants left: %+v", skipped)
	}
	if got := f.operations(abandoned, "tenant_end_episode"); got != 1 {
		t.Fatalf("linger created %d end operations after the participants left, want 1", got)
	}
}

// A fence from another transaction still means control is busy, but only for
// the Episode that owns it.
func TestDeadlineCycleForeignFenceSkipsOnlyThatEpisode(t *testing.T) {
	f := newSchedulerFixture(t)
	blocked, foreignOperationID := f.blockedEpisode(`now() - interval '2 seconds'`)
	due := f.episode(`now() - interval '1 second'`, 1, false)

	cycle := f.run()

	// The Episode has no live presence, so the linger phase also tries it and
	// meets the same fence.
	skipped := f.skippedFor(cycle, blocked)
	phases := map[string]bool{}
	for _, skip := range skipped {
		phases[skip.Phase] = true
		if skip.TenantID != blocked.tenantID || !errors.Is(skip.Err, episodes.ErrEpisodeControlBusy) {
			t.Fatalf("blocked Episode skip = %+v, want control busy for its Tenant", skip)
		}
	}
	if !phases[deadlinePhase] {
		t.Fatalf("blocked Episode skips = %+v, want a skip in the deadline phase", skipped)
	}
	if got := f.operations(blocked, "maximum_episode_duration_expired"); got != 0 {
		t.Fatalf("skipped Episode kept %d deadline operations", got)
	}
	if got := f.count(`select count(*) from episodes where id=$1 and status='active'`, blocked.episodeID.Bytes()); got != 1 {
		t.Fatalf("skipped Episode left active = %d, want 1", got)
	}
	if got := f.count(`select count(*) from sync_publication_fences where episode_id=$1 and external_operation_id=$2`, blocked.episodeID.Bytes(), foreignOperationID.Bytes()); got != 1 {
		t.Fatalf("foreign fence was taken over: %d fences still owned by the foreign operation, want 1", got)
	}
	if got := f.operations(due, "maximum_episode_duration_expired"); got != 1 {
		t.Fatalf("other Episode got %d deadline operations, want 1", got)
	}
	if got := f.count(`select count(*) from episodes where id=$1 and status='ending'`, due.episodeID.Bytes()); got != 1 {
		t.Fatalf("other Episode ending = %d, want 1", got)
	}
}

// Skipped Episodes stay eligible, and claims return the oldest first. A batch
// worth of busy Episodes must not hide the healthy overdue Episode behind them.
func TestDeadlineCycleBusyBatchDoesNotStarveHealthyEpisode(t *testing.T) {
	f := newSchedulerFixture(t)
	const batch = 3
	var blocked []schedulerEpisode
	for range batch + 1 {
		episode, _ := f.blockedEpisode(`now() - interval '40 days'`)
		blocked = append(blocked, episode)
	}
	healthy := f.episode(`now() - interval '30 days'`, 1, false)

	cycle := f.runWithBatch(batch)

	if got := f.operations(healthy, "maximum_episode_duration_expired"); got != 1 {
		t.Fatalf("healthy overdue Episode behind %d busy Episodes got %d deadline operations, want 1", len(blocked), got)
	}
	for _, episode := range blocked {
		if skipped := f.skippedFor(cycle, episode); len(skipped) == 0 {
			t.Fatalf("busy Episode %s was not reported as skipped", episode.episodeID)
		}
		if got := f.operations(episode, "maximum_episode_duration_expired"); got != 0 {
			t.Fatalf("busy Episode kept %d deadline operations", got)
		}
	}
}
