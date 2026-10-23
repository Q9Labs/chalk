package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestSpaceActivityPublicHTTP(t *testing.T) {
	ctx := context.Background()
	pool := accountTenantIntegrationPool(t)
	tenantID, otherTenantID := accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	liveSpaceID, emptySpaceID, endedSpaceID, otherSpaceID := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	for _, id := range []utilities.ID{tenantID, otherTenantID} {
		if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,'Live read test')`, uuid(id)); err != nil {
			t.Fatal(err)
		}
	}
	for _, space := range []struct{ id, tenant utilities.ID }{{liveSpaceID, tenantID}, {emptySpaceID, tenantID}, {endedSpaceID, tenantID}, {otherSpaceID, otherTenantID}} {
		if _, err := pool.Exec(ctx, `insert into spaces(id,tenant_id,name,slug,media_plane) values($1,$2,'Live read Space',$3,'cf_sfu')`, uuid(space.id), uuid(space.tenant), space.id.String()); err != nil {
			t.Fatal(err)
		}
	}
	queries := sqlc.New(pool)
	liveEpisodeID, endedEpisodeID, otherEpisodeID := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	for _, episode := range []struct{ id, space, tenant utilities.ID }{{liveEpisodeID, liveSpaceID, tenantID}, {endedEpisodeID, endedSpaceID, tenantID}, {otherEpisodeID, otherSpaceID, otherTenantID}} {
		deadline := time.Now().Add(time.Hour)
		if _, err := queries.CreateLifecycleEpisode(ctx, sqlc.CreateLifecycleEpisodeParams{ID: uuid(episode.id), TenantID: uuid(episode.tenant), SpaceID: uuid(episode.space), DeadlineAt: timestamptz(&deadline), ArtifactPolicy: []byte(`{}`), MediaPlaneBinding: []byte(`{}`)}); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `insert into sync_episode_control(tenant_id,space_id,episode_id,folded_state,state_schema_version,state_digest,snapshot_bytes) values($1,$2,$3,$4::jsonb,1,decode(repeat('00',32),'hex'),2)`, uuid(episode.tenant), uuid(episode.space), uuid(episode.id), fmt.Sprintf(`{"participants":[{"participant_id":%q,"display_name":"Malik Haddad"},{"participant_id":%q,"display_name":"Meeting Agent"}]}`, accountTenantIntegrationID(t).String(), accountTenantIntegrationID(t).String())); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `update episodes set status='ended',ended_at=now() where id=$1`, uuid(endedEpisodeID)); err != nil {
		t.Fatal(err)
	}
	// A previous ended Episode must not supply the latest roster, even if started later.
	oldEpisodeID := accountTenantIntegrationID(t)
	deadline := time.Now().Add(time.Hour)
	if _, err := queries.CreateLifecycleEpisode(ctx, sqlc.CreateLifecycleEpisodeParams{ID: uuid(oldEpisodeID), TenantID: uuid(tenantID), SpaceID: uuid(endedSpaceID), DeadlineAt: timestamptz(&deadline), ArtifactPolicy: []byte(`{}`), MediaPlaneBinding: []byte(`{}`)}); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `update episodes set status='ended',ended_at=now(),space_id=$2,created_at=now()-interval '1 day',started_at=now()+interval '1 day' where id=$1`, uuid(oldEpisodeID), uuid(liveSpaceID)); err != nil {
		t.Fatal(err)
	}

	participantIDs := make([]utilities.ID, 8)
	for i := range participantIDs {
		participantIDs[i] = accountTenantIntegrationID(t)
		// First joins differ from current joins; index 7 never joined.
		if _, err := pool.Exec(ctx, `insert into participants(id,tenant_id,space_id,episode_id,name,capabilities,generation,status,role,first_joined_at,joined_at) values($1,$2,$3,$4,$5,array['publishAudio'],1,'left','guest',case when $6::int < 6 then now()+$6*interval '1 minute' else null end,case when $6::int < 7 then now()-$6*interval '1 minute' else null end)`, uuid(participantIDs[i]), uuid(tenantID), uuid(liveSpaceID), uuid(liveEpisodeID), fmt.Sprintf("Person %d", i), i); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `insert into participants(id,tenant_id,space_id,episode_id,name,capabilities,generation,status,role,joined_at) values($1,$2,$3,$4,'Old person',array['publishAudio'],1,'left','guest',now()+interval '1 day')`, uuid(accountTenantIntegrationID(t)), uuid(tenantID), uuid(liveSpaceID), uuid(oldEpisodeID)); err != nil {
		t.Fatal(err)
	}
	endedParticipantID := accountTenantIntegrationID(t)
	if _, err := pool.Exec(ctx, `insert into participants(id,tenant_id,space_id,episode_id,name,capabilities,generation,status,role,joined_at) values($1,$2,$3,$4,'Legacy joined person',array['publishAudio'],1,'left','guest',now())`, uuid(endedParticipantID), uuid(tenantID), uuid(endedSpaceID), uuid(endedEpisodeID)); err != nil {
		t.Fatal(err)
	}
	keys := apikeys.NewService(NewAPIKeyRepository(queries, pool), apikeys.Config{})
	key, err := keys.Create(ctx, apikeys.CreateInput{TenantID: tenantID, Name: "Live read caller", Scopes: []authentication.Scope{authentication.ScopeEpisodesRead}, ExpiresAt: time.Now().Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	noScope, err := keys.Create(ctx, apikeys.CreateInput{TenantID: tenantID, Name: "No Episode access", Scopes: []authentication.Scope{authentication.ScopeSpacesRead}, ExpiresAt: time.Now().Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	router := httpapi.NewRouter(httpapi.Options{Episodes: episodes.NewService(NewEpisodeLifecycleRepository(pool)), APIKeyAuthentication: keys, TenantAuthz: authorization.NewTenantPolicy(nil, nil)})
	request := func(tenant utilities.ID, ids, token string, want int) []byte {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, "/v1/tenants/"+tenant.String()+"/space-activity?space_ids="+ids, nil)
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		response := httptest.NewRecorder()
		router.ServeHTTP(response, r)
		if response.Code != want {
			t.Fatalf("status=%d want=%d body=%s", response.Code, want, response.Body.String())
		}
		return response.Body.Bytes()
	}
	ids := liveSpaceID.String() + "," + emptySpaceID.String() + "," + endedSpaceID.String()
	var response struct {
		Spaces []struct {
			SpaceID       string `json:"space_id"`
			Archived      bool   `json:"archived"`
			LatestEpisode *struct {
				EpisodeID string  `json:"episode_id"`
				Status    string  `json:"status"`
				StartedAt string  `json:"started_at"`
				EndedAt   *string `json:"ended_at"`
			} `json:"latest_episode"`
			RecentParticipants []struct {
				ParticipantID string `json:"participant_id"`
				DisplayName   string `json:"display_name"`
			} `json:"recent_participants"`
			LiveEpisode *struct {
				EpisodeID        string `json:"episode_id"`
				ParticipantCount int    `json:"participant_count"`
				Participants     []struct {
					ParticipantID string `json:"participant_id"`
					DisplayName   string `json:"display_name"`
				} `json:"participants"`
			} `json:"live_episode"`
		} `json:"spaces"`
	}
	if err := json.Unmarshal(request(tenantID, ids, key.RawKey, http.StatusOK), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Spaces) != 3 {
		t.Fatalf("expected three Spaces: %+v", response)
	}
	for _, space := range response.Spaces {
		if space.Archived {
			t.Fatalf("unarchived Space read as archived: %+v", space)
		}
		if space.SpaceID == liveSpaceID.String() {
			live := space.LiveEpisode
			if live == nil || live.EpisodeID != liveEpisodeID.String() || live.ParticipantCount != 2 || len(live.Participants) != 2 || live.Participants[0].DisplayName != "Malik Haddad" || live.Participants[1].DisplayName != "Meeting Agent" {
				t.Fatalf("unexpected live Episode: %+v", live)
			}
			for _, participant := range live.Participants {
				if _, err := utilities.ParseID(participant.ParticipantID); err != nil {
					t.Fatal(err)
				}
			}
		} else if space.LiveEpisode != nil {
			t.Fatalf("Space without a live Episode returned one: %+v", space)
		}
	}
	for _, space := range response.Spaces {
		switch space.SpaceID {
		case emptySpaceID.String():
			if space.LatestEpisode != nil || space.RecentParticipants == nil || len(space.RecentParticipants) != 0 {
				t.Fatalf("empty Space: %+v", space)
			}
		case endedSpaceID.String():
			if space.LatestEpisode == nil || space.LatestEpisode.EpisodeID != endedEpisodeID.String() || space.LatestEpisode.Status != "ended" || space.LatestEpisode.EndedAt == nil || space.LatestEpisode.StartedAt == "" || len(space.RecentParticipants) != 1 || space.RecentParticipants[0].ParticipantID != endedParticipantID.String() {
				t.Fatalf("ended Space: %+v", space)
			}
		case liveSpaceID.String():
			if space.LatestEpisode == nil || space.LatestEpisode.EpisodeID != liveEpisodeID.String() || space.LatestEpisode.Status != "active" || space.LatestEpisode.EndedAt != nil || space.LatestEpisode.StartedAt == "" || len(space.RecentParticipants) != 5 {
				t.Fatalf("restarted Space: %+v", space)
			}
			for i, participant := range space.RecentParticipants {
				if participant.ParticipantID != participantIDs[5-i].String() || participant.DisplayName != fmt.Sprintf("Person %d", 5-i) {
					t.Fatalf("recent order: %+v", space.RecentParticipants)
				}
			}
		}
	}
	request(tenantID, ids, "", http.StatusUnauthorized)
	request(tenantID, ids, noScope.RawKey, http.StatusForbidden)
	request(otherTenantID, otherSpaceID.String(), key.RawKey, http.StatusForbidden)
	request(tenantID, liveSpaceID.String()+","+otherSpaceID.String(), key.RawKey, http.StatusNotFound)
	request(tenantID, accountTenantIntegrationID(t).String(), key.RawKey, http.StatusNotFound)
	for _, invalid := range []string{"", "bad-id", liveSpaceID.String() + "," + liveSpaceID.String()} {
		request(tenantID, invalid, key.RawKey, http.StatusBadRequest)
	}
	tooMany := ""
	for i := 0; i < 301; i++ {
		if i != 0 {
			tooMany += ","
		}
		tooMany += accountTenantIntegrationID(t).String()
	}
	request(tenantID, tooMany, key.RawKey, http.StatusBadRequest)
	// The next read must reflect committed current presence, not a cached roster.
	if _, err := pool.Exec(ctx, `update sync_episode_control set folded_state='{"participants":[]}'::jsonb where tenant_id=$1 and episode_id=$2`, uuid(tenantID), uuid(liveEpisodeID)); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(request(tenantID, liveSpaceID.String(), key.RawKey, http.StatusOK), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Spaces) != 1 || response.Spaces[0].LiveEpisode == nil || response.Spaces[0].LiveEpisode.ParticipantCount != 0 || len(response.Spaces[0].LiveEpisode.Participants) != 0 {
		t.Fatalf("current empty roster not reflected: %+v", response)
	}
	// A large live roster returns its full count but only its first five Participants, so 300 Spaces stay small.
	roster := make([]string, 0, 7)
	for i := 0; i < 7; i++ {
		roster = append(roster, fmt.Sprintf(`{"participant_id":%q,"display_name":"Guest %d"}`, accountTenantIntegrationID(t).String(), i))
	}
	if _, err := pool.Exec(ctx, `update sync_episode_control set folded_state=$3::jsonb where tenant_id=$1 and episode_id=$2`, uuid(tenantID), uuid(liveEpisodeID), `{"participants":[`+strings.Join(roster, ",")+`]}`); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(request(tenantID, liveSpaceID.String(), key.RawKey, http.StatusOK), &response); err != nil {
		t.Fatal(err)
	}
	if live := response.Spaces[0].LiveEpisode; live == nil || live.ParticipantCount != 7 || len(live.Participants) != 5 || live.Participants[0].DisplayName != "Guest 0" || live.Participants[4].DisplayName != "Guest 4" {
		t.Fatalf("large live roster not bounded: %+v", response.Spaces[0].LiveEpisode)
	}
	// An ending Episode and an archived Space follow the unchanged live-read semantics, and the row says it is archived.
	if _, err := pool.Exec(ctx, `update episodes set status='ending' where id=$1`, uuid(liveEpisodeID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `update spaces set archived_at=now() where id=$1`, uuid(liveSpaceID)); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(request(tenantID, liveSpaceID.String(), key.RawKey, http.StatusOK), &response); err != nil {
		t.Fatal(err)
	}
	if !response.Spaces[0].Archived || response.Spaces[0].LatestEpisode.Status != "ending" || response.Spaces[0].LiveEpisode == nil {
		t.Fatalf("ending archived Space: %+v", response)
	}

	// Seed enough history and unrelated Spaces for the planner to choose selective indexes.
	if _, err := pool.Exec(ctx, `insert into spaces(id,tenant_id,name,slug,media_plane) select gen_random_uuid(),$1,'Plan seed',gen_random_uuid()::text,'cf_sfu' from generate_series(1,2000)`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into episodes(id,tenant_id,space_id,status,started_at,ended_at,created_at,config_snapshot) select gen_random_uuid(),s.tenant_id,s.id,'ended',now()-interval '1 day',now(),now()-g.n*interval '1 day',e.config_snapshot from spaces s cross join generate_series(1,5) g(n) join episodes e on e.id=$2 where s.tenant_id=$1`, uuid(tenantID), uuid(liveEpisodeID)); err != nil {
		t.Fatal(err)
	}
	// Ten seats in each of the 10,000 seeded Episodes: about 100,000 Participants, joined at different times.
	if _, err := pool.Exec(ctx, `insert into participants(id,tenant_id,space_id,episode_id,name,capabilities,generation,status,role,first_joined_at,joined_at) select gen_random_uuid(),e.tenant_id,e.space_id,e.id,'Plan person '||g.n,array['publishAudio'],1,'left','guest',e.created_at+g.n*interval '1 minute',e.created_at+g.n*interval '1 minute' from episodes e cross join generate_series(1,10) g(n) where e.tenant_id=$1 and e.id!=$2`, uuid(tenantID), uuid(liveEpisodeID)); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"spaces", "episodes", "participants", "sync_episode_control"} {
		if _, err := pool.Exec(ctx, "analyze "+table); err != nil {
			t.Fatal(err)
		}
	}
	batchRows, err := pool.Query(ctx, `select id::text from spaces where tenant_id=$1 order by id limit 300`, uuid(tenantID))
	if err != nil {
		t.Fatal(err)
	}
	batchIDs := make([]string, 0, 300)
	for batchRows.Next() {
		var id string
		if err := batchRows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		batchIDs = append(batchIDs, id)
	}
	if err := batchRows.Err(); err != nil {
		t.Fatal(err)
	}
	batchRows.Close()
	if err := json.Unmarshal(request(tenantID, strings.Join(batchIDs, ","), key.RawKey, http.StatusOK), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Spaces) != 300 {
		t.Fatalf("300-Space batch returned %d", len(response.Spaces))
	}
	query, err := os.ReadFile("../../../db/queries/space_activity.sql")
	if err != nil {
		t.Fatal(err)
	}
	// Many seats in one Episode: the five most recent joins must come from an index, not a sort of every seat.
	if _, err := pool.Exec(ctx, `insert into participants(id,tenant_id,space_id,episode_id,name,capabilities,generation,status,role,first_joined_at,joined_at)
		select gen_random_uuid(),$1,$2,$3,'Seat '||n,array['publishAudio'],1,'left','guest',now()-n*interval '1 second',now()-n*interval '1 second' from generate_series(1,5000) n`, uuid(tenantID), uuid(liveSpaceID), uuid(liveEpisodeID)); err != nil {
		t.Fatal(err)
	}
	// Time the migration's rebuild of the recent-join index on these seats.
	var seats int
	if err := pool.QueryRow(ctx, `select count(*) from participants`).Scan(&seats); err != nil {
		t.Fatal(err)
	}
	var took [2]time.Duration
	for index, statement := range spaceActivityIndexMigrationUp(t) {
		started := time.Now()
		if err := runStatements(ctx, pool, []string{statement}); err != nil {
			t.Fatalf("recent-join index migration: %v", err)
		}
		took[index] = time.Since(started).Round(time.Millisecond)
	}
	var size string
	if err := pool.QueryRow(ctx, `select pg_size_pretty(pg_relation_size('participants_episode_recent_join_idx'))`).Scan(&size); err != nil {
		t.Fatal(err)
	}
	t.Logf("recent-join index migration over %d seats: drop %s, build %s, index %s", seats, took[0], took[1], size)
	if _, err := pool.Exec(ctx, `analyze participants`); err != nil {
		t.Fatal(err)
	}
	explain := "explain (analyze, buffers) " + strings.NewReplacer("sqlc.arg(tenant_id)", "$1", "sqlc.arg(space_ids)", "$2").Replace(string(query))
	for _, batch := range []struct {
		name string
		ids  []string
	}{{"three Spaces", []string{liveSpaceID.String(), emptySpaceID.String(), endedSpaceID.String()}}, {"300 Spaces", append(batchIDs[:299:299], liveSpaceID.String())}} {
		rows, err := pool.Query(ctx, explain, uuid(tenantID), batch.ids)
		if err != nil {
			t.Fatal(err)
		}
		var plan strings.Builder
		for rows.Next() {
			var line string
			if err := rows.Scan(&line); err != nil {
				t.Fatal(err)
			}
			plan.WriteString(line + "\n")
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		t.Logf("Space activity plan for %s:\n%s", batch.name, plan.String())
		if !strings.Contains(plan.String(), "episodes_tenant_space_created_at_id_idx") || !strings.Contains(plan.String(), "participants_episode_recent_join_idx") {
			t.Fatalf("%s: latest Episode or recent Participants not read from their index: %s", batch.name, plan.String())
		}
		if strings.Contains(plan.String(), "Seq Scan on participants") || strings.Contains(plan.String(), "Seq Scan on episodes") {
			t.Fatalf("%s: sequential scan: %s", batch.name, plan.String())
		}
	}
}
