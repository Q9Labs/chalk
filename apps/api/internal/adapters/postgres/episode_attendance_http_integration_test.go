package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
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

func TestEpisodeAttendancePublicHTTP(t *testing.T) {
	ctx := context.Background()
	pool := accountTenantIntegrationPool(t)
	tenant, otherTenant, space, otherSpace, episode, emptyEpisode := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []utilities.ID{tenant, otherTenant} {
		exec(`insert into tenants(id,name) values($1,'Attendance test')`, uuid(id))
	}
	exec(`insert into spaces(id,tenant_id,name,slug,media_plane) values($1,$2,'Attendance test',$3,'cf_sfu'),($4,$5,'Other Space',$6,'cf_sfu')`, uuid(space), uuid(tenant), space.String(), uuid(otherSpace), uuid(otherTenant), otherSpace.String())
	queries := sqlc.New(pool)
	for _, id := range []utilities.ID{episode, emptyEpisode} {
		deadline := time.Now().Add(time.Hour)
		if _, err := queries.CreateLifecycleEpisode(ctx, sqlc.CreateLifecycleEpisodeParams{ID: uuid(id), TenantID: uuid(tenant), SpaceID: uuid(space), DeadlineAt: timestamptz(&deadline), ArtifactPolicy: []byte(`{}`), MediaPlaneBinding: []byte(`{}`)}); err != nil {
			t.Fatal(err)
		}
		exec(`update episodes set status='ended',ended_at=now() where id=$1`, uuid(id))
	}
	exec(`update episodes set status='active',ended_at=null where id=$1`, uuid(episode))
	guest, user, agent, neverJoined := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	userIdentity, agentIdentity := accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	exec(`insert into identities(id,tenant_id,kind,external_id,display_name) values($1,$2,'user','user-1','User'),($3,$2,'agent','agent-1','Agent')`, uuid(userIdentity), uuid(tenant), uuid(agentIdentity))
	first := time.Now().UTC().Truncate(time.Second).Add(-time.Hour)
	latestJoin, explicitLeave, end := first.Add(20*time.Minute), first.Add(30*time.Minute), first.Add(time.Hour)
	for index, seat := range []struct {
		id, identity utilities.ID
		name, status string
	}{{guest, utilities.ID{}, "Guest", "active"}, {user, userIdentity, "User", "left"}, {agent, agentIdentity, "Agent", "active"}, {neverJoined, utilities.ID{}, "Pending", "joining"}} {
		joined := first.Add(time.Duration(index) * time.Minute)
		exec(`insert into participants(id,tenant_id,space_id,episode_id,generation,status,role,capabilities,name,identity_id,joined_at,first_joined_at) values($1,$2,$3,$4,1,$5,'observer','{subscribe}',$6,$7,$8,$8)`, uuid(seat.id), uuid(tenant), uuid(space), uuid(episode), seat.status, seat.name, uuid(seat.identity), joined)
	}
	exec(`update participants set joined_at=null,first_joined_at=null where id=$1`, uuid(neverJoined))
	// A current seat may retain the previous departure in left_at after rejoining.
	exec(`update participants set joined_at=$2,left_at=$3 where id=$1`, uuid(guest), latestJoin, first.Add(10*time.Minute))
	exec(`update participants set left_at=$2,last_left_reason='left' where id=$1`, uuid(user), explicitLeave)
	keys := apikeys.NewService(NewAPIKeyRepository(queries, pool), apikeys.Config{})
	makeKey := func(tenant utilities.ID, scope authentication.Scope) string {
		t.Helper()
		result, err := keys.Create(ctx, apikeys.CreateInput{TenantID: tenant, Name: "Attendance caller", Scopes: []authentication.Scope{scope}, ExpiresAt: time.Now().Add(time.Hour)})
		if err != nil {
			t.Fatal(err)
		}
		return result.RawKey
	}
	key, otherKey, noScope := makeKey(tenant, authentication.ScopeEpisodesRead), makeKey(otherTenant, authentication.ScopeEpisodesRead), makeKey(tenant, authentication.ScopeSpacesRead)
	router := httpapi.NewRouter(httpapi.Options{Episodes: episodes.NewService(NewEpisodeLifecycleRepository(pool)), APIKeyAuthentication: keys, TenantAuthz: authorization.NewTenantPolicy(nil)})
	type participant struct {
		ParticipantID string     `json:"participant_id"`
		DisplayName   string     `json:"display_name"`
		IdentityKind  string     `json:"identity_kind"`
		ExternalID    *string    `json:"external_id"`
		FirstJoinedAt time.Time  `json:"first_joined_at"`
		LastLeftAt    *time.Time `json:"last_left_at"`
		LeftReason    *string    `json:"left_reason"`
	}
	type attendance struct {
		EpisodeID    string        `json:"episode_id"`
		Participants []participant `json:"participants"`
	}
	read := func(tenant, space, episode utilities.ID, token string, want int) attendance {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, "/v1/tenants/"+tenant.String()+"/spaces/"+space.String()+"/episodes/"+episode.String()+"/attendance", nil)
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != want {
			t.Fatalf("status=%d want=%d body=%s", response.Code, want, response.Body.String())
		}
		var result attendance
		if want == http.StatusOK {
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
		}
		return result
	}
	live := read(tenant, space, episode, key, http.StatusOK)
	if live.EpisodeID != episode.String() || len(live.Participants) != 3 {
		t.Fatalf("unexpected attendance: %+v", live)
	}
	g, u, a := live.Participants[0], live.Participants[1], live.Participants[2]
	if g.ParticipantID != guest.String() || g.DisplayName != "Guest" || g.IdentityKind != "guest" || g.ExternalID != nil || !g.FirstJoinedAt.Equal(first) || g.LastLeftAt != nil || g.LeftReason != nil {
		t.Fatalf("unexpected rejoined Guest: %+v", g)
	}
	if u.IdentityKind != "user" || u.ExternalID == nil || *u.ExternalID != "user-1" || u.LastLeftAt == nil || !u.LastLeftAt.Equal(explicitLeave) || u.LeftReason == nil || *u.LeftReason != "left" {
		t.Fatalf("unexpected User: %+v", u)
	}
	if a.IdentityKind != "agent" || a.ExternalID == nil || *a.ExternalID != "agent-1" {
		t.Fatalf("unexpected Agent: %+v", a)
	}
	// End fallback covers a seat whose explicit departure never arrived.
	exec(`update episodes set status='ended',ended_at=$2 where id=$1`, uuid(episode), end)
	ended := read(tenant, space, episode, key, http.StatusOK)
	for _, index := range []int{0, 2} {
		p := ended.Participants[index]
		if p.LastLeftAt == nil || !p.LastLeftAt.Equal(end) || p.LeftReason == nil || *p.LeftReason != "episode_ended" {
			t.Fatalf("unclosed ended seat: %+v", p)
		}
	}
	if ended.Participants[1].LastLeftAt == nil || !ended.Participants[1].LastLeftAt.Equal(explicitLeave) || *ended.Participants[1].LeftReason != "left" {
		t.Fatal("Episode end overwrote explicit leave")
	}
	if empty := read(tenant, space, emptyEpisode, key, http.StatusOK); empty.Participants == nil || len(empty.Participants) != 0 {
		t.Fatalf("empty Episode: %+v", empty)
	}
	read(tenant, space, episode, "", http.StatusUnauthorized)
	read(tenant, space, episode, noScope, http.StatusForbidden)
	read(tenant, space, episode, otherKey, http.StatusForbidden)
	read(otherTenant, space, episode, otherKey, http.StatusNotFound)
	read(tenant, otherSpace, episode, key, http.StatusNotFound)
	read(tenant, space, accountTenantIntegrationID(t), key, http.StatusNotFound)
}

// The Sync retention proof invokes this compiled probe before and after its real cleanup.
func TestEpisodeAttendanceSyncFixtureHTTP(t *testing.T) {
	if os.Getenv("CHALK_ATTENDANCE_EPISODE_ID") == "" {
		t.Skip("run from the Sync retention proof")
	}
	tenant, err := utilities.ParseID(os.Getenv("CHALK_ATTENDANCE_TENANT_ID"))
	if err != nil {
		t.Fatal(err)
	}
	space, err := utilities.ParseID(os.Getenv("CHALK_ATTENDANCE_SPACE_ID"))
	if err != nil {
		t.Fatal(err)
	}
	episode, err := utilities.ParseID(os.Getenv("CHALK_ATTENDANCE_EPISODE_ID"))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	pool := accountTenantIntegrationPool(t)
	queries := sqlc.New(pool)
	keys := apikeys.NewService(NewAPIKeyRepository(queries, pool), apikeys.Config{})
	key, err := keys.Create(ctx, apikeys.CreateInput{TenantID: tenant, Name: "Retention proof", Scopes: []authentication.Scope{authentication.ScopeEpisodesRead}, ExpiresAt: time.Now().Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `delete from api_keys where id=$1`, uuid(key.Key.ID)); err != nil {
			t.Error(err)
		}
	})
	router := httpapi.NewRouter(httpapi.Options{Episodes: episodes.NewService(NewEpisodeLifecycleRepository(pool)), APIKeyAuthentication: keys, TenantAuthz: authorization.NewTenantPolicy(nil)})
	request := httptest.NewRequest(http.MethodGet, "/v1/tenants/"+tenant.String()+"/spaces/"+space.String()+"/episodes/"+episode.String()+"/attendance", nil)
	request.Header.Set("Authorization", "Bearer "+key.RawKey)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var result struct {
		Participants []struct {
			IdentityKind  string     `json:"identity_kind"`
			FirstJoinedAt time.Time  `json:"first_joined_at"`
			LastLeftAt    *time.Time `json:"last_left_at"`
			LeftReason    *string    `json:"left_reason"`
		} `json:"participants"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Participants) != 1 {
		t.Fatalf("attendance=%s", response.Body.String())
	}
	participant := result.Participants[0]
	if participant.IdentityKind != "guest" || participant.FirstJoinedAt.IsZero() || participant.LastLeftAt == nil || participant.LeftReason == nil || *participant.LeftReason != "episode_ended" {
		t.Fatalf("invalid ended attendance=%s", response.Body.String())
	}
	fmt.Printf("ATTENDANCE_JSON=%s", response.Body.String())
}
