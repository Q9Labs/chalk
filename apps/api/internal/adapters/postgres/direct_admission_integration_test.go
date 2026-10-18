package postgres

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type directAdmissionMedia struct {
	service mediaplane.Service
	binding mediaplane.Binding
}

func (m directAdmissionMedia) Resolve(context.Context, tenants.Tenant, spaces.Space) (*mediaplane.Service, error) {
	return &m.service, nil
}
func (m directAdmissionMedia) ResolveBinding(tenants.Tenant, spaces.Space) (*mediaplane.Binding, error) {
	return &m.binding, nil
}

type directAdmissionResponse struct {
	ID          string `json:"id"`
	Participant struct {
		ID           string   `json:"id"`
		Generation   int64    `json:"generation"`
		Role         string   `json:"role"`
		Capabilities []string `json:"capabilities"`
	} `json:"participant"`
	Intent struct {
		ID         string `json:"id"`
		IntentName string `json:"intent_name"`
	} `json:"lifecycle_intent"`
	AdmissionRequest *struct {
		ID string `json:"id"`
	} `json:"admission_request"`
	Access *struct {
		Sync struct {
			Token string `json:"token"`
		} `json:"sync"`
		Media struct {
			Token string `json:"token"`
		} `json:"media"`
	} `json:"access"`
	SyncToken string `json:"sync_token"`
	Error     struct {
		Code string `json:"code"`
	} `json:"error"`
}

// Exercise the public HTTP boundary with real API keys, services, signing, and
// PostgreSQL. Only the external Cloudflare session allocation is a local fixture.
func TestDirectAdmissionHTTP(t *testing.T) {
	databaseURL := os.Getenv(config.DatabaseURL)
	if testing.Short() || databaseURL == "" {
		t.Skip("isolated PostgreSQL integration database is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	tenantID, foreignID := accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	for _, id := range []utilities.ID{tenantID, foreignID} {
		exec(`insert into tenants(id,name) values($1,'Direct admission HTTP fixture')`, uuid(id))
		exec(`insert into tenant_artifact_policies(tenant_id) values($1)`, uuid(id))
	}
	queries := sqlc.New(pool)
	keys := apikeys.NewService(NewAPIKeyRepository(queries, pool), apikeys.Config{})
	key := func(tenant utilities.ID, scopes ...authentication.Scope) string {
		t.Helper()
		result, err := keys.Create(ctx, apikeys.CreateInput{TenantID: tenant, Name: "Direct admission fixture", Scopes: scopes, ExpiresAt: time.Now().Add(time.Hour)})
		if err != nil {
			t.Fatal(err)
		}
		return result.RawKey
	}
	writer := key(tenantID, authentication.ScopeEpisodesWrite)
	reader := key(tenantID, authentication.ScopeEpisodesRead)
	foreign := key(foreignID, authentication.ScopeEpisodesWrite)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/apps/fixture-app/sessions/new" {
			t.Errorf("unexpected vendor request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"sessionId":%q}`, accountTenantIntegrationID(t).String())
	}))
	defer provider.Close()
	adapter, err := sfu.NewAdapterWithClient(config.CloudflareRealtimeConfig{RealtimeAppID: "fixture-app", RealtimeAppSecret: "fixture-secret", RequestTimeout: time.Second}, provider.Client(), provider.URL)
	if err != nil {
		t.Fatal(err)
	}
	binding, err := mediaplane.NewBinding("cf_sfu", mediaplane.BindingSourceDeploymentDefault, "fixture-app")
	if err != nil {
		t.Fatal(err)
	}
	media := directAdmissionMedia{service: mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareSFU, adapter), binding: binding}
	repository := NewEpisodeLifecycleRepositoryWithMediaBinding(pool, media)
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	syncTokens, err := synctokens.NewService(synctokens.Config{Issuer: "fixture", Audience: "fixture", KeyID: "fixture", PrivateKey: privateKey})
	if err != nil {
		t.Fatal(err)
	}
	mediaTokens, err := accessgrants.NewIssuer(accessgrants.IssuerConfig{Issuer: "fixture", KeyID: "fixture", PrivateKey: privateKey})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(httpapi.NewRouter(httpapi.Options{
		APIKeyAuthentication: keys, TenantAuthz: authorization.NewTenantPolicy(nil), Episodes: episodes.NewService(repository),
		Spaces: spaces.NewService(NewSpaceRepository(queries, pool)), Tenants: tenants.NewService(NewTenantRepository(queries)),
		SyncTokens: syncTokens, ParticipantMediaIssuer: mediaTokens, ParticipantGeneration: accessgrants.NewActiveAuthorizer(repository), MediaPlane: media,
	}))
	defer server.Close()
	post := func(t *testing.T, path, token, requestKey, body string, status int) directAdmissionResponse {
		t.Helper()
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Idempotency-Key", requestKey)
		res, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != status {
			t.Fatalf("POST %s: status=%d want=%d body=%s", path, res.StatusCode, status, raw)
		}
		var out directAdmissionResponse
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	// The durable journey root is the record an investigation reads to learn
	// whether a caller asked to skip the admission gate.
	journeyRoot := func(t *testing.T, intentID string) string {
		t.Helper()
		var raw []byte
		if err := pool.QueryRow(ctx, `select e.attributes from observability_journey_events e join sync_lifecycle_intents i on i.journey_id=e.journey_id where i.lifecycle_intent_id=$1 and e.name='participant.admission_requested'`, intentID).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var attributes map[string]string
		if err := json.Unmarshal(raw, &attributes); err != nil {
			t.Fatal(err)
		}
		return fmt.Sprint(attributes)
	}
	for _, mode := range []string{"knock", "members_only", "open"} {
		t.Run(mode, func(t *testing.T) {
			spaceID := accountTenantIntegrationID(t)
			exec(`insert into spaces(id,tenant_id,name,slug,media_plane,admission_policy) values($1,$2,'Direct admission fixture',$3,'cf_sfu',$4)`, uuid(spaceID), uuid(tenantID), spaceID.String(), []byte(fmt.Sprintf(`{"mode":%q}`, mode)))
			exec(`insert into space_roles(id,tenant_id,space_id,name,capabilities) values($1,$2,$3,'custom_guest',array['sendChat'])`, uuid(accountTenantIntegrationID(t)), uuid(tenantID), uuid(spaceID))
			if mode == "members_only" {
				// New members_only Episodes are retired; create a current Episode,
				// then model the persisted pre-retirement policy in the fixture.
				exec(`update spaces set admission_policy='{"mode":"open"}' where id=$1`, uuid(spaceID))
			}
			base := fmt.Sprintf("/v1/tenants/%s/spaces/%s/episodes", tenantID, spaceID)
			episode := post(t, base, writer, "create-direct-admission-"+mode, `{}`, http.StatusCreated)
			if mode == "members_only" {
				setLegacyDirectAdmissionFixture(t, ctx, pool, episode.ID, spaceID)
			}
			path := base + "/" + episode.ID + "/participants"
			body := fmt.Sprintf(`{"participant_id":%q,"name":"Guest","role":"custom_guest","admission":"direct","metadata":{"source":"backend"}}`, accountTenantIntegrationID(t).String())
			requestKey := "direct-admission-request-" + mode
			admitted := post(t, path, writer, requestKey, body, http.StatusCreated)
			if admitted.Participant.ID == "" || admitted.Access == nil || admitted.Access.Sync.Token == "" || admitted.Access.Media.Token == "" || admitted.SyncToken == "" || admitted.AdmissionRequest != nil || admitted.Intent.IntentName != "participant_joined" {
				t.Fatal("direct admission did not return normal access")
			}
			if admitted.Participant.Role != "custom_guest" || len(admitted.Participant.Capabilities) != 1 || admitted.Participant.Capabilities[0] != "sendChat" {
				t.Fatal("direct admission did not use the snapshot role capabilities")
			}
			if got, want := journeyRoot(t, admitted.Intent.ID), "map[admission:direct request:participant.admission_requested]"; got != want {
				t.Fatalf("direct admission journey root = %s, want %s", got, want)
			}
			var payload json.RawMessage
			if err := pool.QueryRow(ctx, `select payload from sync_lifecycle_intents where lifecycle_intent_id=$1`, admitted.Intent.ID).Scan(&payload); err != nil {
				t.Fatal(err)
			}
			participantID, err := utilities.ParseID(admitted.Participant.ID)
			if err != nil {
				t.Fatal(err)
			}
			var actual, expected map[string]string
			if err := json.Unmarshal(payload, &actual); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(episodes.ParticipantJoinedPayload(participantID, "Guest", "custom_guest"), &expected); err != nil {
				t.Fatal(err)
			}
			if len(actual) != len(expected) {
				t.Fatal("direct admission changed the Sync payload shape")
			}
			for key, value := range expected {
				if actual[key] != value {
					t.Fatalf("unexpected Sync payload %s", key)
				}
			}
			var count int
			if err := pool.QueryRow(ctx, `select count(*) from sync_admission_requests where tenant_id=$1 and space_id=$2 and episode_id=$3`, uuid(tenantID), uuid(spaceID), episode.ID).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count != 0 {
				t.Fatalf("direct admission queued %d requests", count)
			}
			retry := post(t, path, writer, requestKey, body, http.StatusCreated)
			if retry.Participant.ID != admitted.Participant.ID || retry.Participant.Generation != admitted.Participant.Generation || retry.Intent.ID != admitted.Intent.ID {
				t.Fatal("retry did not return the same seat and intent")
			}
			post(t, path, writer, requestKey, strings.Replace(body, `"direct"`, `"policy"`, 1), http.StatusConflict)
			post(t, path, writer, "direct-unknown-role-"+mode, strings.Replace(body, "custom_guest", "unknown", 1), http.StatusBadRequest)
			post(t, path, reader, "direct-missing-scope-"+mode, body, http.StatusForbidden)
			post(t, path, foreign, "direct-foreign-key-"+mode, body, http.StatusForbidden)
			post(t, strings.Replace(path, tenantID.String(), foreignID.String(), 1), foreign, "direct-foreign-space-"+mode, body, http.StatusNotFound)
			post(t, path, writer, "direct-invalid-mode-"+mode, strings.Replace(body, `"direct"`, `"invalid"`, 1), http.StatusBadRequest)
			if mode == "knock" {
				policyBody := ""
				for _, explicit := range []bool{false, true} {
					policyKey := fmt.Sprintf("policy-admission-%t", explicit)
					policyBody = fmt.Sprintf(`{"participant_id":%q,"name":"Guest","role":"custom_guest"}`, accountTenantIntegrationID(t).String())
					if explicit {
						policyBody = strings.TrimSuffix(policyBody, "}") + `,"admission":"policy"}`
					}
					queued := post(t, path, writer, policyKey, policyBody, http.StatusCreated)
					if queued.AdmissionRequest == nil || queued.Access != nil || queued.SyncToken != "" {
						t.Fatalf("policy admission did not knock: %+v", queued)
					}
					if got, want := journeyRoot(t, queued.Intent.ID), "map[request:participant.admission_requested]"; got != want {
						t.Fatalf("policy admission journey root = %s, want %s", got, want)
					}
					equivalent := policyBody
					if !explicit {
						equivalent = strings.TrimSuffix(policyBody, "}") + `,"admission":"policy"}`
					}
					replay := post(t, path, writer, policyKey, equivalent, http.StatusCreated)
					if replay.Participant.ID != queued.Participant.ID || replay.AdmissionRequest.ID != queued.AdmissionRequest.ID {
						t.Fatal("policy retry changed seat")
					}
					post(t, path, writer, policyKey, strings.TrimSuffix(strings.ReplaceAll(policyBody, `,"admission":"policy"`, ""), "}")+`,"admission":"direct"}`, http.StatusConflict)
				}
				if err := pool.QueryRow(ctx, `select count(*) from sync_admission_requests where episode_id=$1`, episode.ID).Scan(&count); err != nil {
					t.Fatal(err)
				}
				if count != 2 {
					t.Fatalf("policy queued %d requests, want 2", count)
				}
			}
			var reserved int64
			if err := pool.QueryRow(ctx, `select snapshot_reserved_bytes from sync_episode_control where episode_id=$1`, episode.ID).Scan(&reserved); err != nil {
				t.Fatal(err)
			}
			exec(`update sync_episode_control set snapshot_reserved_bytes=1048576-snapshot_bytes where episode_id=$1`, episode.ID)
			post(t, path, writer, "direct-capacity-limit-"+mode, body, http.StatusConflict)
			exec(`update sync_episode_control set snapshot_reserved_bytes=$2 where episode_id=$1`, episode.ID, reserved)
			exec(`update episodes set status='ended',ended_at=now() where id=$1`, episode.ID)
			post(t, path, writer, "direct-ended-episode-"+mode, body, http.StatusConflict)
		})
	}
}

// Model a legacy Episode without changing the production creation validator.
// The trigger bypass is transaction-local, only for this fresh fixture; the
// folded state and digest retain the exact v1 format consumed by Sync.
func setLegacyDirectAdmissionFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool, episodeID string, spaceID utilities.ID) {
	t.Helper()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	var folded json.RawMessage
	if err := tx.QueryRow(ctx, `select folded_state from sync_episode_control where episode_id=$1`, episodeID).Scan(&folded); err != nil {
		t.Fatal(err)
	}
	var state map[string]json.RawMessage
	if err := json.Unmarshal(folded, &state); err != nil {
		t.Fatal(err)
	}
	state["admission_policy"] = json.RawMessage(`"members_only"`)
	folded, err = json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(append([]byte("chalk-sync-state-v1\x00\x00\x00\x01"), folded...))
	state["state_digest"], err = json.Marshal(hex.EncodeToString(digest[:]))
	if err != nil {
		t.Fatal(err)
	}
	wire, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`set local session_replication_role=replica`, nil},
		{`update spaces set admission_policy='{"mode":"members_only"}' where id=$1`, []any{uuid(spaceID)}},
		{`update episodes set config_snapshot=jsonb_set(config_snapshot,'{admission_policy,mode}','"members_only"') where id=$1`, []any{episodeID}},
		{`update sync_episode_control set folded_state=$2,state_digest=$3,snapshot_bytes=$4 where episode_id=$1`, []any{episodeID, folded, digest[:], len(wire)}},
	} {
		if _, err := tx.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}
