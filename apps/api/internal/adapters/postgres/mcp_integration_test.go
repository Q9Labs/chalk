package postgres

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/publicinviteapp"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingpreparation"
	"github.com/q9labs/chalk/apps/api/internal/recordings"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

type mcpHeaderTransport struct {
	token string
	next  http.RoundTripper
}

func (h mcpHeaderTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	clone := r.Clone(r.Context())
	clone.Header = r.Header.Clone()
	clone.Header.Set("Authorization", "Bearer "+h.token)
	return h.next.RoundTrip(clone)
}
func connectMCP(t *testing.T, server *httptest.Server, token, version string) *mcp.ClientSession {
	t.Helper()
	client := mcp.NewClient(&mcp.Implementation{Name: "chalk-integration", Version: "1"}, nil)
	httpClient := &http.Client{Transport: mcpHeaderTransport{token: token, next: server.Client().Transport}}
	session, err := client.Connect(t.Context(), &mcp.StreamableClientTransport{Endpoint: server.URL + "/mcp", HTTPClient: httpClient}, &mcp.ClientSessionOptions{ProtocolVersion: version})
	if err != nil {
		t.Fatalf("MCP initialize (%s): %v", version, err)
	}
	if result := session.InitializeResult(); result.ProtocolVersion != version {
		t.Fatalf("negotiated %s, want %s", result.ProtocolVersion, version)
	}
	t.Cleanup(func() {
		if err := session.Close(); err != nil {
			t.Error(err)
		}
	})
	return session
}
func callMCP(t *testing.T, session *mcp.ClientSession, name, args string) *mcp.CallToolResult {
	t.Helper()
	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "chalk_" + name, Arguments: json.RawMessage(args)})
	if err != nil {
		t.Fatalf("MCP %s protocol failure: %v", name, err)
	}
	return result
}
func mcpText(result *mcp.CallToolResult) string {
	var text strings.Builder
	for _, content := range result.Content {
		if c, ok := content.(*mcp.TextContent); ok {
			text.WriteString(c.Text)
		}
	}
	return text.String()
}
func mcpData(t *testing.T, result *mcp.CallToolResult) json.RawMessage {
	t.Helper()
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal([]byte(mcpText(result)), &envelope); err != nil {
		t.Fatal(err)
	}
	return envelope.Data
}

type mcpToolCase struct {
	name, args string
	wantError  string
}

func TestMCPPostgresToolsAndPermissions(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	ctx := t.Context()
	q := sqlc.New(pool)
	ids := func() utilities.ID { return accountTenantIntegrationID(t) }
	tenantID, foreignTenant, spaceID, emptySpace, episodeID, participantID, recordingID, transcriptID, userID := ids(), ids(), ids(), ids(), ids(), ids(), ids(), ids(), ids()
	mustExec(t, pool, `insert into tenants(id,name) values($1,'MCP own'),($2,'MCP foreign private')`, uuid(tenantID), uuid(foreignTenant))
	mustExec(t, pool, `insert into tenant_artifact_policies(tenant_id) values($1),($2)`, uuid(tenantID), uuid(foreignTenant))
	mustExec(t, pool, `insert into spaces(id,tenant_id,name,slug,media_plane,recording_policy) values($1,$2,'MCP Space',$3,'cf_sfu','manual'),($4,$2,'Empty MCP Space',$5,'cf_sfu','disabled')`, uuid(spaceID), uuid(tenantID), spaceID.String(), uuid(emptySpace), emptySpace.String())
	for _, id := range []utilities.ID{spaceID, emptySpace} {
		mustExec(t, pool, `insert into space_roles(id,tenant_id,space_id,name,capabilities) values($1,$2,$3,'collaborator',array['sendChat'])`, uuid(ids()), uuid(tenantID), uuid(id))
	}
	binding, err := mediaplane.NewBinding("cf_sfu", mediaplane.BindingSourceDeploymentDefault, "fixture-app")
	if err != nil {
		t.Fatal(err)
	}
	episodeRepo := NewEpisodeLifecycleRepositoryWithMediaBinding(pool, directAdmissionMedia{binding: binding})
	if _, err := episodes.NewService(episodeRepo).CreateEpisode(ctx, episodes.CreateEpisodeInput{ID: episodeID, TenantID: tenantID, SpaceID: spaceID, Request: episodes.Request{Key: "mcp-fixture-episode-0001"}}); err != nil {
		t.Fatal(err)
	}
	mustExec(t, pool, `insert into participants(id,tenant_id,space_id,episode_id,name,generation,status,role,capabilities) values($1,$2,$3,$4,'MCP participant',1,'active','collaborator',array['sendChat'])`, uuid(participantID), uuid(tenantID), uuid(spaceID), uuid(episodeID))
	objectKey := recordings.TenantStorageKeyPrefix(tenantID) + recordingID.String() + ".mp4"
	mustExec(t, pool, `insert into recordings(id,tenant_id,space_id,episode_id,status,storage_provider,storage_key) values($1,$2,$3,$4,'completed','r2',$5)`, uuid(recordingID), uuid(tenantID), uuid(spaceID), uuid(episodeID), objectKey)
	renderJob := ids()
	mustExec(t, pool, `insert into recording_jobs(id,tenant_id,episode_id,recording_id,kind,idempotency_key,payload_schema_version,state,attempt_limit,terminal_at,available_at) values($1,$2,$3,$4,'render',$5,1,'succeeded',3,now(),now())`, uuid(renderJob), uuid(tenantID), uuid(episodeID), uuid(recordingID), "render:"+recordingID.String())
	mustExec(t, pool, `insert into recording_artifacts(recording_id,tenant_id,render_job_id,object_key,content_type,byte_size,checksum,duration_millis,committed_at,expires_at) values($1,$2,$3,$4,'video/mp4',1,$5,1000,now(),now()+interval '1 day')`, uuid(recordingID), uuid(tenantID), uuid(renderJob), objectKey, make([]byte, 32))
	mustExec(t, pool, `insert into transcriptions(id,tenant_id,recording_id,space_id,episode_id,status,languages) values($1,$2,$3,$4,$5,'not_requested','{}')`, uuid(transcriptID), uuid(tenantID), uuid(recordingID), uuid(spaceID), uuid(episodeID))
	mustExec(t, pool, `insert into users(id,email,name) values($1,$2,'MCP member')`, uuid(userID), userID.String()+"@example.invalid")
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		for _, table := range []string{"webhook_deliveries", "webhook_events", "webhook_endpoints", "api_keys", "memberships", "recording_artifacts", "recording_jobs", "transcriptions", "recordings", "recording_preparations", "space_public_invites", "sync_admission_requests", "sync_lifecycle_intents", "sync_external_operations", "sync_episode_control", "participants", "episode_create_requests", "episodes", "space_roles", "space_create_requests", "spaces", "tenant_artifact_policies"} {
			if _, err := pool.Exec(cleanup, "delete from "+table+" where tenant_id=$1", uuid(tenantID)); err != nil {
				t.Errorf("cleanup %s: %v", table, err)
			}
		}
		if _, err := pool.Exec(cleanup, `delete from tenants where id=$1 or id=$2`, uuid(tenantID), uuid(foreignTenant)); err != nil {
			t.Error(err)
		}
		if _, err := pool.Exec(cleanup, `delete from users where id=$1`, uuid(userID)); err != nil {
			t.Error(err)
		}
	})
	keys := apikeys.NewService(NewAPIKeyRepository(q, pool), apikeys.Config{})
	makeKey := func(scopes []authentication.Scope) apikeys.CreateResult {
		t.Helper()
		key, err := keys.Create(ctx, apikeys.CreateInput{TenantID: tenantID, Name: "MCP fixture", Scopes: scopes, ExpiresAt: time.Now().Add(time.Hour)})
		if err != nil {
			t.Fatal(err)
		}
		return key
	}
	full := makeKey(authentication.AllScopes)
	denied := makeKey([]authentication.Scope{authentication.ScopeSigningKeysRead})
	disposable := makeKey([]authentication.Scope{authentication.ScopeSpacesRead})
	protector, err := webhooks.NewAESGCMProtector(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	webhookRepo := NewWebhookRepository(pool, protector)
	webhookService := webhooks.NewService(webhookRepo, protector)
	hook, err := webhookService.Create(ctx, webhooks.CreateInput{TenantID: tenantID, Name: "MCP hook", URL: "https://example.com/mcp-hook", Enabled: true, APIVersion: 1, EventTypes: []string{"participant.joined"}, IdempotencyKey: "mcp-hook-fixture-0001"})
	if err != nil {
		t.Fatal(err)
	}
	spaceService := spaces.NewService(NewSpaceRepository(q, pool))
	tenantService := tenants.NewService(NewTenantRepository(q))
	inviteRepo := NewPublicInviteRepositoryWithPool(pool).WithEpisodeLifecycle(episodeRepo)
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := publicinvites.NewSigner(publicinvites.Keyring{CurrentKeyID: "mcp-fixture", Signer: privateKey, Verifiers: map[string]ed25519.PublicKey{"mcp-fixture": publicKey}})
	if err != nil {
		t.Fatal(err)
	}
	inviteService, err := publicinvites.NewServiceWithLifecycle(inviteRepo, inviteRepo, signer)
	if err != nil {
		t.Fatal(err)
	}
	spacePort, err := publicinviteapp.NewSpacePort(spaceService, tenantService, publicinviteapp.SpaceConfig{ManagedTenantID: tenantID, DefaultMediaPlane: "cf_sfu"})
	if err != nil {
		t.Fatal(err)
	}
	inviteRuntime, err := publicinvites.NewRuntime(inviteService, spacePort, inviteRepo, &terminalAdmissionAccess{}, admissionProofAccounts{}, admissionProofLinks{})
	if err != nil {
		t.Fatal(err)
	}
	transcriptRepo := NewTranscriptRepositoryWithPool(q, pool)
	storage := objectstorage.NewService(mcpDownloadStore{key: objectKey})
	options := httpapi.Options{APIKeys: keys, APIKeyAuthentication: keys, TenantAuthz: authorization.NewTenantPolicy(NewMembershipRepository(q, pool), NewTenantRepository(q)), Tenants: tenantService, Memberships: memberships.NewService(NewMembershipRepository(q, pool)), Spaces: spaceService, Episodes: episodes.NewService(episodeRepo), PublicInvites: inviteRuntime, RecordingPreparations: recordingpreparation.NewService(NewRecordingPreparationRepository(pool), spaceService), Recordings: recordings.NewService(NewRecordingRepository(q)), RecordingExports: recordingpipeline.NewService(NewRecordingPipelineRepositoryWithPool(pool)), RecordingDownloads: storage, RecordingObjects: storage, TranscriptArtifacts: transcripts.NewArtifactService(transcriptRepo, transcriptRepo), Webhooks: webhookService, RateLimit: httpapi.DefaultRateLimitOptions()}
	options.RateLimit.DisableAuthenticated = true
	options.LocalSystemToken = "mcp-system-fixture"
	options.MCP = httpapi.NewMCPHandler(options)
	server := httptest.NewServer(httpapi.NewRouter(options))
	t.Cleanup(server.Close)
	for _, token := range []string{"", "mcp-system-fixture"} {
		request := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{}`))
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response := httptest.NewRecorder()
		httpapi.NewRouter(options).ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("non-key credential accepted: %d", response.Code)
		}
	}
	fullSession := connectMCP(t, server, full.RawKey, "2026-07-28")
	deniedSession := connectMCP(t, server, denied.RawKey, "2025-11-25")
	foreignSpace := ids()
	mustExec(t, pool, `insert into spaces(id,tenant_id,name,slug,media_plane) values($1,$2,'Foreign private Space',$3,'cf_sfu')`, uuid(foreignSpace), uuid(foreignTenant), foreignSpace.String())
	t.Cleanup(func() {
		_, err := pool.Exec(context.Background(), `delete from spaces where id=$1`, uuid(foreignSpace))
		if err != nil {
			t.Error(err)
		}
	})
	cases := mcpCases(t, spaceID, emptySpace, episodeID, participantID, recordingID, transcriptID, userID, disposable.Key.ID, hook.Endpoint.ID)
	listed, err := fullSession.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.Tools) != len(cases) {
		t.Fatalf("tools/list count=%d want=%d", len(listed.Tools), len(cases))
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			deniedResult := callMCP(t, deniedSession, test.name, test.args)
			if !deniedResult.IsError || !strings.Contains(mcpText(deniedResult), "forbidden") {
				t.Fatalf("missing-scope call was not denied: %s", mcpText(deniedResult))
			}
			result := callMCP(t, fullSession, test.name, test.args)
			if test.wantError != "" {
				if !result.IsError || !strings.Contains(mcpText(result), test.wantError) {
					t.Fatalf("want %s; got %s", test.wantError, mcpText(result))
				}
			} else if result.IsError {
				t.Fatalf("authorized tool failed: %s", mcpText(result))
			}
		})
	}
	// Exhaust the public HTTP write budget with invalid bodies, then prove MCP
	// cannot evade that same per-key bucket. Read tools must remain usable.
	limitedOptions := options
	limitedOptions.RateLimit.DisableAuthenticated = false
	limitedOptions.MCP = httpapi.NewMCPHandler(limitedOptions)
	limitedRouter := httpapi.NewRouter(limitedOptions)
	for range 60 {
		request := httptest.NewRequest(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/spaces", strings.NewReader("{"))
		request.Header.Set("Authorization", "Bearer "+full.RawKey)
		response := httptest.NewRecorder()
		limitedRouter.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("write-budget setup status=%d", response.Code)
		}
	}
	limitedServer := httptest.NewServer(limitedRouter)
	t.Cleanup(limitedServer.Close)
	limitedSession := connectMCP(t, limitedServer, full.RawKey, "2026-07-28")
	result := callMCP(t, limitedSession, "create_space", `{"request_key":"mcp-rate-limit-proof","body":{"name":"must not exist","slug":"mcp-rate-limit-proof"}}`)
	if !result.IsError || !strings.Contains(mcpText(result), "rate_limited") {
		t.Fatalf("MCP escaped the HTTP write quota: %s", mcpText(result))
	}
	result = callMCP(t, limitedSession, "list_spaces", `{}`)
	if result.IsError {
		t.Fatal("exhausting writes also denied reads")
	}
	var name string
	if err := pool.QueryRow(ctx, `select name from spaces where id=$1`, uuid(spaceID)).Scan(&name); err != nil || name != "MCP changed Space" {
		t.Fatalf("MCP write not durable: name=%q error=%v", name, err)
	}
	for _, version := range []string{"2026-07-28", "2025-11-25"} {
		t.Run("isolation/"+version, func(t *testing.T) {
			session := connectMCP(t, server, full.RawKey, version)
			result := callMCP(t, session, "get_connection", `{}`)
			if result.IsError || !strings.Contains(string(mcpData(t, result)), tenantID.String()) {
				t.Fatal("connection lost its tenant binding")
			}
			result = callMCP(t, session, "inspect_space", fmt.Sprintf(`{"space_id":%q}`, foreignSpace))
			if !result.IsError || strings.Contains(mcpText(result), "MCP foreign private") {
				t.Fatal("foreign identifier escaped tenant isolation")
			}
		})
	}
	guarded := makeKey([]authentication.Scope{authentication.ScopeSpacesRead, authentication.ScopeAPIKeysWrite, authentication.ScopeAPIKeysDelete, authentication.ScopeWebhooksWrite})
	guardedSession := connectMCP(t, server, guarded.RawKey, "2026-07-28")
	for _, attempt := range []mcpToolCase{
		{name: "issue_api_key", args: fmt.Sprintf(`{"action":"create","request_key":"mcp-escalation-create","create":{"name":"must fail","scopes":["tenants:write"],"expires_at":%q}}`, time.Now().Add(time.Hour).UTC().Format(time.RFC3339))},
		{name: "issue_api_key", args: fmt.Sprintf(`{"action":"rotate","api_key_id":%q,"request_key":"mcp-escalation-rotate"}`, full.Key.ID)},
		{name: "revoke_api_key", args: fmt.Sprintf(`{"api_key_id":%q}`, full.Key.ID)},
		{name: "configure_webhook", args: fmt.Sprintf(`{"action":"delete","endpoint_id":%q,"revision":2,"request_key":"mcp-forbidden-delete"}`, hook.Endpoint.ID)},
		{name: "prepare_recording", args: fmt.Sprintf(`{"action":"cancel","space_id":%q,"expected_revision":1}`, spaceID)},
	} {
		result := callMCP(t, guardedSession, attempt.name, attempt.args)
		if !result.IsError || !strings.Contains(mcpText(result), "forbidden") {
			t.Fatalf("scope escalation or wrong action scope accepted for %s", attempt.name)
		}
	}
	// Schema validation must reject tenant selection and missing destructive
	// action fields before any operation can execute.
	for _, attempt := range []mcpToolCase{
		{name: "list_spaces", args: fmt.Sprintf(`{"tenant_id":%q}`, foreignTenant)},
		{name: "configure_space", args: fmt.Sprintf(`{"action":"invite","space_id":%q}`, spaceID)},
		{name: "configure_webhook", args: fmt.Sprintf(`{"action":"delete","endpoint_id":%q}`, hook.Endpoint.ID)},
	} {
		result, err := fullSession.CallTool(ctx, &mcp.CallToolParams{Name: "chalk_" + attempt.name, Arguments: json.RawMessage(attempt.args)})
		if err == nil && !result.IsError {
			t.Fatalf("invalid action input accepted for %s", attempt.name)
		}
	}
	for _, test := range cases {
		if test.name == "create_episode" {
			result := callMCP(t, fullSession, test.name, test.args)
			if result.IsError {
				t.Fatalf("idempotent replay failed: %s", mcpText(result))
			}
		}
	}
	var episodeCount int
	if err := pool.QueryRow(ctx, `select count(*) from episodes where space_id=$1`, uuid(emptySpace)).Scan(&episodeCount); err != nil || episodeCount != 1 {
		t.Fatalf("Episode retry duplicated durable work: count=%d err=%v", episodeCount, err)
	}
	// Reauthentication is required on every call, not only initialize.
	if err := keys.Revoke(ctx, tenantID, denied.Key.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := deniedSession.CallTool(ctx, &mcp.CallToolParams{Name: "chalk_get_connection", Arguments: json.RawMessage(`{}`)}); err == nil {
		t.Fatal("revoked key retained an initialized MCP connection")
	}
}
