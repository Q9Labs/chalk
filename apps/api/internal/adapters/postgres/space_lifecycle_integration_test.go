package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/observability"
)

func TestSpaceArchiveRestoreWritesAtomicJourneyTransitions(t *testing.T) {
	databaseURL := os.Getenv("CHALK_SPACE_LIFECYCLE_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("CHALK_SPACE_LIFECYCLE_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Fatal(err)
	}

	tenantID := mustSpaceWebhookTestID(t, "44444444-4444-4444-8444-444444444444")
	spaceID := mustSpaceWebhookTestID(t, "55555555-5555-4555-8555-555555555555")
	roleID := mustSpaceWebhookTestID(t, "66666666-6666-4666-8666-666666666666")
	episodeID := mustSpaceWebhookTestID(t, "88888888-8888-4888-8888-888888888888")
	participantID := mustSpaceWebhookTestID(t, "99999999-9999-4999-8999-999999999999")
	journeyID := mustSpaceWebhookTestID(t, "77777777-7777-4777-8777-777777777777")
	ctx = observability.ContextWithJourneyID(ctx, journeyID)

	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `delete from observability_journey_events where journey_id=$1`, uuid(journeyID))
		_, _ = pool.Exec(cleanupCtx, `delete from webhook_events where tenant_id=$1`, uuid(tenantID))
		_, _ = pool.Exec(cleanupCtx, `delete from webhook_tenant_state where tenant_id=$1`, uuid(tenantID))
		_, _ = pool.Exec(cleanupCtx, `delete from sync_lifecycle_intents where tenant_id=$1 and space_id=$2 and episode_id=$3`, uuid(tenantID), uuid(spaceID), uuid(episodeID))
		_, _ = pool.Exec(cleanupCtx, `delete from sync_episode_control where tenant_id=$1 and space_id=$2 and episode_id=$3`, uuid(tenantID), uuid(spaceID), uuid(episodeID))
		_, _ = pool.Exec(cleanupCtx, `delete from episodes where tenant_id=$1 and space_id=$2 and id=$3`, uuid(tenantID), uuid(spaceID), uuid(episodeID))
		_, _ = pool.Exec(cleanupCtx, `delete from space_roles where tenant_id=$1 and space_id=$2`, uuid(tenantID), uuid(spaceID))
		_, _ = pool.Exec(cleanupCtx, `delete from spaces where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(spaceID))
		_, _ = pool.Exec(cleanupCtx, `delete from tenants where id=$1`, uuid(tenantID))
	})

	if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,'Space lifecycle proof')`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into spaces(id,tenant_id,name,slug,media_plane) values($1,$2,'Private planning','private-planning','cf_rtk')`, uuid(spaceID), uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into space_roles(id,tenant_id,space_id,name,capabilities) values($1,$2,$3,'observer',array['subscribe']::text[])`, uuid(roleID), uuid(tenantID), uuid(spaceID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into episodes(id,status,space_id,tenant_id,started_at,deadline_at,config_snapshot) values($1,'active',$2,$3,now(),now()+interval '1 hour','{"roles":{"observer":["subscribe"]},"admission_policy":{"mode":"open"},"default_episode_duration_seconds":86400,"maximum_episode_duration_seconds":86400,"linger_window_seconds":0}'::jsonb)`, uuid(episodeID), uuid(spaceID), uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into sync_episode_control(tenant_id,space_id,episode_id,folded_state,state_schema_version,state_digest,snapshot_bytes) values($1,$2,$3,'{"control_revision":0,"participants":[],"state_schema_version":1,"status":"active"}'::jsonb,1,decode(repeat('00',32),'hex'),0)`, uuid(tenantID), uuid(spaceID), uuid(episodeID)); err != nil {
		t.Fatal(err)
	}

	repository := NewSpaceRepository(sqlc.New(pool), pool)
	archived, err := repository.ArchiveSpace(ctx, tenantID, spaceID)
	if err != nil {
		t.Fatalf("archive space: %v", err)
	}
	if archived.ArchivedAt == nil {
		t.Fatalf("archive response = %#v", archived)
	}
	admissionService := episodes.NewService(NewEpisodeLifecycleRepository(pool))
	if _, err := admissionService.AdmitParticipant(ctx, episodes.AdmitParticipantInput{
		TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID,
		Name: "Archived admission proof", Role: "observer", Request: episodes.Request{Key: "archive-admission-proof"},
	}); !errors.Is(err, episodes.ErrAdmissionClosed) {
		t.Fatalf("admit participant on archived Space error = %v, want ErrAdmissionClosed", err)
	}
	var participantCount, intentCount int
	if err := pool.QueryRow(ctx, `select count(*) from participants where tenant_id=$1 and space_id=$2 and episode_id=$3`, uuid(tenantID), uuid(spaceID), uuid(episodeID)).Scan(&participantCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select count(*) from sync_lifecycle_intents where tenant_id=$1 and space_id=$2 and episode_id=$3`, uuid(tenantID), uuid(spaceID), uuid(episodeID)).Scan(&intentCount); err != nil {
		t.Fatal(err)
	}
	if participantCount != 0 || intentCount != 0 {
		t.Fatalf("archived admission left participant/intents: %d/%d", participantCount, intentCount)
	}
	restored, err := repository.RestoreSpace(ctx, tenantID, spaceID)
	if err != nil {
		t.Fatalf("restore space: %v", err)
	}
	if restored.ArchivedAt != nil {
		t.Fatalf("restore response = %#v", restored)
	}

	rows, err := pool.Query(ctx, `select name,phase,state,sequence,attributes from observability_journey_events where journey_id=$1 order by name asc`, uuid(journeyID))
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	type journeyRow struct {
		name, phase, state string
		sequence           int64
		attributes         []byte
	}
	var events []journeyRow
	for rows.Next() {
		var event journeyRow
		if err := rows.Scan(&event.name, &event.phase, &event.state, &event.sequence, &event.attributes); err != nil {
			t.Fatal(err)
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(events) != 4 {
		t.Fatalf("journey events = %#v, want archive/restore request and terminal pairs", events)
	}
	wantSequences := map[string]int64{
		"space.archived_requested": 0,
		"space.archived":           1,
		"space.restored_requested": 0,
		"space.restored":           1,
	}
	for _, event := range events {
		wantSequence, ok := wantSequences[event.name]
		if !ok {
			t.Fatalf("unexpected journey event %q", event.name)
		}
		if event.sequence != wantSequence {
			t.Fatalf("journey event %q sequence = %d, want %d", event.name, event.sequence, wantSequence)
		}
		if (event.name == "space.archived" || event.name == "space.restored") && (event.phase != "terminal" || event.state != "succeeded") {
			t.Fatalf("terminal event %q = %s/%s", event.name, event.phase, event.state)
		}
		var attributes map[string]any
		if err := json.Unmarshal(event.attributes, &attributes); err != nil {
			t.Fatalf("journey event %q attributes: %v", event.name, err)
		}
		for _, forbidden := range []string{"name", "slug", "metadata", "admission_policy", "request_body", "space_id", "tenant_id"} {
			if _, ok := attributes[forbidden]; ok {
				t.Fatalf("journey event %q leaked %q: %s", event.name, forbidden, event.attributes)
			}
		}
	}
}
