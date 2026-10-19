package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
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

func TestSpaceLiveEpisodesPublicHTTP(t *testing.T) {
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
		r := httptest.NewRequest(http.MethodGet, "/v1/tenants/"+tenant.String()+"/live-episodes?space_ids="+ids, nil)
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
			SpaceID     string `json:"space_id"`
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
	request(tenantID, ids, "", http.StatusUnauthorized)
	request(tenantID, ids, noScope.RawKey, http.StatusForbidden)
	request(otherTenantID, otherSpaceID.String(), key.RawKey, http.StatusForbidden)
	request(tenantID, liveSpaceID.String()+","+otherSpaceID.String(), key.RawKey, http.StatusNotFound)
	request(tenantID, accountTenantIntegrationID(t).String(), key.RawKey, http.StatusNotFound)
	for _, invalid := range []string{"", "bad-id", liveSpaceID.String() + "," + liveSpaceID.String()} {
		request(tenantID, invalid, key.RawKey, http.StatusBadRequest)
	}
	tooMany := ""
	for i := 0; i < 31; i++ {
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
}
