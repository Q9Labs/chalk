package postgres

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/apitest"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/chatattachments"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingobjects"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingpreparation"
	"github.com/q9labs/chalk/apps/api/internal/recordings"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
	"github.com/q9labs/chalk/apps/api/internal/whiteboardfiles"
)

func TestAuthorizationRouteMatrix(t *testing.T) {
	matrix, err := apitest.RouteMatrix()
	if err != nil {
		t.Fatal(err)
	}
	ctx, pool := chatAttachmentQuotaPool(t)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	own := chatAttachmentQuotaFixture(ctx, t, tx)(true)
	foreign := chatAttachmentQuotaFixture(ctx, t, tx)(true)
	fixture := newRouteMatrixFixture(t, tx, own, foreign)
	router := httpapi.NewRouter(fixture.options)
	mounted := matrixMountedRoutes(t, router)
	for route := range mounted {
		row, covered := matrix[route]
		if !covered {
			t.Errorf("mounted route has no authorization matrix entry: %s", route)
			continue
		}
		if row.PublicReason != "" {
			continue
		}
		if strings.HasPrefix(route, "POST /internal/") {
			continue // The workload matrix below drives these with real leases.
		}
		t.Run(route, func(t *testing.T) {
			request := fixture.request(row, false)
			assertMatrixDenial(t, router, request, http.StatusUnauthorized, fixture.forbiddenData())
			for _, credential := range row.Credentials {
				t.Run(credential.Class, func(t *testing.T) {
					wrong := fixture.request(row, false)
					foreignRequest := fixture.request(row, true)
					switch credential.Class {
					case "tenant session":
						principal := authentication.Principal{Kind: authentication.PrincipalUser, UserID: own.ParticipantID}
						wrong = wrong.WithContext(authentication.ContextWithPrincipal(wrong.Context(), principal))
						foreignRequest = foreignRequest.WithContext(authentication.ContextWithPrincipal(foreignRequest.Context(), principal))
					case "API key":
						principal := authentication.Principal{Kind: authentication.PrincipalAPIKey, APIKeyID: own.ParticipantID, TenantID: own.TenantID}
						wrong = wrong.WithContext(authentication.ContextWithPrincipal(wrong.Context(), principal))
						principal.Scopes = authentication.AllScopes
						foreignRequest = foreignRequest.WithContext(authentication.ContextWithPrincipal(foreignRequest.Context(), principal))
					case "participant media token":
						wrong.Header.Set("Authorization", "Bearer "+fixture.syncToken)
						foreignRequest.Header.Set("Authorization", "Bearer "+fixture.mediaToken)
					case "participant sync token":
						wrong.Header.Set("Authorization", "Bearer "+fixture.mediaToken)
						foreignRequest.Header.Set("Authorization", "Bearer "+fixture.syncToken)
					default:
						t.Fatalf("unknown matrix credential class %q", credential.Class)
					}
					assertMatrixDenial(t, router, wrong, credential.Wrong, fixture.forbiddenData())
					if row.Operation == "initiateChatAttachmentUpload" {
						assertMatrixUploadBinding(t, tx, router, foreignRequest, fixture)
					} else {
						assertMatrixDenial(t, router, foreignRequest, credential.Foreign, fixture.forbiddenData())
					}
				})
			}
		})
	}
	for route := range matrix {
		if !mounted[route] && !strings.HasPrefix(route, "POST /internal/") {
			t.Errorf("stale authorization matrix entry: %s", route)
		}
	}
}

func matrixMountedRoutes(t *testing.T, handler http.Handler) map[string]bool {
	t.Helper()
	router, ok := handler.(chi.Routes)
	if !ok {
		t.Fatal("real router does not expose mounted routes")
	}
	mounted := make(map[string]bool)
	if err := chi.Walk(router, func(method, path string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		mounted[method+" "+path] = true
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return mounted
}

func assertMatrixDenial(t *testing.T, router http.Handler, request *http.Request, status int, forbidden []string) {
	t.Helper()
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != status {
		t.Fatalf("%s %s: got %d, want %d: %s", request.Method, request.URL.Path, response.Code, status, response.Body.String())
	}
	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	decoder := json.NewDecoder(strings.NewReader(response.Body.String()))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil || envelope.Error.Code == "" || envelope.Error.Message == "" {
		t.Fatalf("denial must contain only a typed error, not resource data: %s (%v)", response.Body.String(), err)
	}
	if status == http.StatusConflict && envelope.Error.Code != "lease.stale" {
		t.Fatalf("foreign lease error = %q, want lease.stale", envelope.Error.Code)
	}
	output := response.Body.String() + response.Header().Get("Location")
	if response.Header().Get("Location") != "" || strings.Contains(output, "https://") || strings.Contains(output, "http://") {
		t.Fatalf("denial leaked a redirect or URL: %s", output)
	}
	for _, secret := range forbidden {
		if secret != "" && strings.Contains(output, secret) {
			t.Fatalf("denial leaked another party's identifier or data %q: %s", secret, output)
		}
	}
}

type routeMatrixFixture struct {
	options                httpapi.Options
	own, foreign           chatattachments.Subject
	attachmentID, uploadID utilities.ID
	fileID                 string
	syncToken, mediaToken  string
}

func newRouteMatrixFixture(t *testing.T, tx pgx.Tx, own, foreign chatattachments.Subject) routeMatrixFixture {
	t.Helper()
	q := sqlc.New(tx)
	tenantRepo := NewTenantRepository(q)
	membershipRepo := NewMembershipRepository(q, tx)
	spaceService := spaces.NewService(NewSpaceRepository(q))
	episodeRepo := NewEpisodeLifecycleRepository(lingerTestTransactor{tx})
	episodeService := episodes.NewService(episodeRepo)
	transcriptRepo := NewTranscriptRepositoryWithPool(q, tx)
	transcriptService := transcripts.NewArtifactService(transcriptRepo, transcriptRepo)
	storage := objectstorage.NewService(matrixObjectStore{})
	objects, err := recordingobjects.NewService(storage, NewRecordingObjectRepository(q), recordingobjects.Config{})
	if err != nil {
		t.Fatal(err)
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := synctokens.NewService(synctokens.Config{Issuer: "matrix", Audience: "sync", KeyID: "matrix", PrivateKey: privateKey})
	if err != nil {
		t.Fatal(err)
	}
	syncVerifier, err := synctokens.NewVerifier(synctokens.VerifierConfig{Issuer: "matrix", Audience: "sync", VerificationKeys: map[string]ed25519.PublicKey{"matrix": publicKey}})
	if err != nil {
		t.Fatal(err)
	}
	mediaSigner, err := accessgrants.NewIssuer(accessgrants.IssuerConfig{Issuer: "matrix", KeyID: "matrix", PrivateKey: privateKey})
	if err != nil {
		t.Fatal(err)
	}
	mediaVerifier, err := accessgrants.NewVerifier(accessgrants.VerifierConfig{Issuer: "matrix", VerificationKeys: map[string]ed25519.PublicKey{"matrix": publicKey}})
	if err != nil {
		t.Fatal(err)
	}
	intentID := accountTenantIntegrationID(t)
	mustExec(t, tx, `insert into sync_episode_control(tenant_id,space_id,episode_id,folded_state,state_schema_version,state_digest,snapshot_bytes) values($1,$2,$3,'{}',1,decode(repeat('00',32),'hex'),2) on conflict do nothing`, uuid(own.TenantID), uuid(own.SpaceID), uuid(own.EpisodeID))
	mustExec(t, tx, `insert into sync_lifecycle_intents(tenant_id,space_id,episode_id,lifecycle_intent_id,request_key,request_fingerprint,intent_name,participant_id,participant_generation,payload,status,applied_event_id,applied_revision,completed_at) values($1,$2,$3,$4,$7,decode(repeat('00',32),'hex'),'participant_joined',$5,1,'{}','applied',$6,1,now())`, uuid(own.TenantID), uuid(own.SpaceID), uuid(own.EpisodeID), uuid(intentID), uuid(own.ParticipantID), uuid(accountTenantIntegrationID(t)), intentID.String())
	t.Cleanup(func() {
		_, _ = tx.Exec(context.Background(), `delete from sync_lifecycle_intents where lifecycle_intent_id=$1`, uuid(intentID))
	})
	syncToken, err := signer.Issue(t.Context(), synctokens.Input{TenantID: own.TenantID, SpaceID: own.SpaceID, EpisodeID: own.EpisodeID, ParticipantID: own.ParticipantID, ParticipantGeneration: 1, AdmissionLifecycleIntentID: intentID, DisplayName: "Matrix caller", Role: "collaborator", Capabilities: []string{"sendChat"}})
	if err != nil {
		t.Fatal(err)
	}
	mediaSubject := accessgrants.Subject{TenantID: own.TenantID, SpaceID: own.SpaceID, EpisodeID: own.EpisodeID, ParticipantID: own.ParticipantID, ParticipantGeneration: 1, Provider: "cf_sfu", CloudflareConnectionID: "matrix-own-connection"}
	mediaToken, err := mediaSigner.Issue(t.Context(), mediaSubject)
	if err != nil {
		t.Fatal(err)
	}
	active := accessgrants.NewActiveAuthorizer(episodeRepo)
	if valid, err := active.AuthorizeActiveParticipant(t.Context(), mediaSubject); err != nil || !valid {
		t.Fatalf("matrix media credential must belong to a real active Participant: %t, %v", valid, err)
	}
	fixture := routeMatrixFixture{own: own, foreign: foreign, syncToken: syncToken.Value, mediaToken: mediaToken.Token}
	reservation := chatAttachmentReservation(t, foreign, 1, 1)
	chatRepo := NewChatAttachmentRepository(tx)
	if _, err := chatRepo.Reserve(t.Context(), reservation); err != nil {
		t.Fatal(err)
	}
	fixture.attachmentID, fixture.uploadID = reservation.Upload.AttachmentID, reservation.Upload.UploadID
	mustExec(t, tx, `update sync_chat_attachments set status='ready',immutable_object_identity='matrix-private-object' where attachment_id=$1`, uuid(fixture.attachmentID))
	fixture.fileID = "matrix-private-file-" + foreign.ParticipantID.String()
	sceneID := accountTenantIntegrationID(t)
	mustExec(t, tx, `insert into sync_whiteboard_scenes(tenant_id,space_id,episode_id,scene_id) values($1,$2,$3,$4)`, uuid(foreign.TenantID), uuid(foreign.SpaceID), uuid(foreign.EpisodeID), uuid(sceneID))
	mustExec(t, tx, `insert into sync_whiteboard_files(upload_id,tenant_id,space_id,episode_id,scene_id,participant_id,participant_generation,file_id,object_key,mime_type,byte_length,sha256,status,immutable_object_identity,expires_at) values($1,$2,$3,$4,$5,$6,1,$7,'matrix-private-whiteboard-object-'||$7,'image/png',1,decode(repeat('00',32),'hex'),'ready','matrix-private-identity',now()+interval '1 hour')`, uuid(accountTenantIntegrationID(t)), uuid(foreign.TenantID), uuid(foreign.SpaceID), uuid(foreign.EpisodeID), uuid(sceneID), uuid(foreign.ParticipantID), fixture.fileID)
	t.Cleanup(func() {
		_, _ = tx.Exec(context.Background(), `delete from sync_whiteboard_files where tenant_id=$1`, uuid(foreign.TenantID))
		_, _ = tx.Exec(context.Background(), `delete from sync_whiteboard_scenes where tenant_id=$1`, uuid(foreign.TenantID))
	})
	fixture.options = httpapi.Options{
		APIKeys: apikeys.NewService(NewAPIKeyRepository(q, tx), apikeys.Config{}),
		Tenants: tenants.NewService(tenantRepo), Memberships: memberships.NewService(membershipRepo),
		TenantAuthz: authorization.NewTenantPolicy(membershipRepo, tenantRepo),
		Spaces:      spaceService, Episodes: episodeService, ParticipantJoins: episodeService,
		ParticipantMediaVerify: mediaVerifier, ParticipantMediaActive: active, ParticipantGeneration: active,
		Recordings:            recordings.NewService(NewRecordingRepository(q)),
		RecordingExports:      recordingpipeline.NewService(NewRecordingPipelineRepositoryWithTransactor(tx)),
		RecordingPreparations: recordingpreparation.NewService(NewRecordingPreparationRepository(nil), spaceService),
		RecordingObjects:      objects, RecordingDownloads: storage, TranscriptArtifacts: transcriptService,
		Webhooks:        webhooks.NewService(NewWebhookRepository(nil), nil),
		ChatAttachments: chatattachments.NewService(chatRepo, storage), ChatParticipants: chatattachments.NewParticipantVerifier(syncVerifier),
		WhiteboardFiles: whiteboardfiles.NewService(NewWhiteboardFileRepository(tx), storage), WhiteboardParticipants: whiteboardfiles.NewParticipantVerifier(syncVerifier),
	}
	matrixMountWorkers(&fixture.options, transcriptService)
	return fixture
}

func (f routeMatrixFixture) request(row apitest.RouteCase, foreign bool) *http.Request {
	method, path, _ := strings.Cut(row.Route, " ")
	subject := f.own
	if foreign {
		subject = f.foreign
	}
	replacer := strings.NewReplacer("{tenant_id}", subject.TenantID.String(), "{space_id}", subject.SpaceID.String(), "{episode_id}", subject.EpisodeID.String(), "{participant_id}", subject.ParticipantID.String(), "{attachmentId}", f.attachmentID.String(), "{uploadId}", f.uploadID.String(), "{fileId}", f.fileID)
	path = replacer.Replace(path)
	// Other route IDs are valid opaque identifiers. Tenant rejection must happen
	// before their existence is queried, whether or not such a resource exists.
	for strings.Contains(path, "{") {
		start := strings.Index(path, "{")
		end := strings.Index(path[start:], "}") + start
		path = path[:start] + f.foreign.ParticipantID.String() + path[end+1:]
	}
	if row.Query != "" {
		path += "?" + row.Query
	}
	request := httptest.NewRequest(method, path, strings.NewReader(row.Body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", "matrix-request-key-0001")
	return request
}

func (f routeMatrixFixture) forbiddenData() []string {
	return []string{f.foreign.TenantID.String(), f.foreign.SpaceID.String(), f.foreign.EpisodeID.String(), f.foreign.ParticipantID.String(), f.attachmentID.String(), f.uploadID.String(), f.fileID, "matrix-private", "chat attachment quota fixture"}
}

type matrixObjectStore struct{ objectstorage.Store }

func (matrixObjectStore) CreateUploadURL(_ context.Context, input objectstorage.CreateUploadURLInput) (objectstorage.SignedURL, error) {
	return objectstorage.SignedURL{Method: http.MethodPut, URL: "https://objects.invalid/" + url.PathEscape(input.Key), SignedAt: time.Now(), ExpiresAt: time.Now().Add(input.ExpiresIn), SignedHeader: map[string][]string{}}, nil
}

func assertMatrixUploadBinding(t *testing.T, tx pgx.Tx, router http.Handler, request *http.Request, fixture routeMatrixFixture) {
	t.Helper()
	foreign := fixture.foreign
	query := url.Values{"tenant_id": {foreign.TenantID.String()}, "space_id": {foreign.SpaceID.String()}, "episode_id": {foreign.EpisodeID.String()}, "participant_id": {foreign.ParticipantID.String()}}
	request.URL.RawQuery = query.Encode()
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("token-bound upload status %d: %s", response.Code, response.Body.String())
	}
	var upload struct {
		UploadID string `json:"uploadId"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &upload); err != nil {
		t.Fatal(err)
	}
	var tenantID, spaceID, episodeID, participantID string
	if err := tx.QueryRow(t.Context(), `select tenant_id::text,space_id::text,episode_id::text,participant_id::text from sync_chat_attachments where upload_id=$1`, upload.UploadID).Scan(&tenantID, &spaceID, &episodeID, &participantID); err != nil {
		t.Fatal(err)
	}
	if tenantID != fixture.own.TenantID.String() || spaceID != fixture.own.SpaceID.String() || episodeID != fixture.own.EpisodeID.String() || participantID != fixture.own.ParticipantID.String() {
		t.Fatalf("foreign query IDs overrode signed upload identity: %s %s %s %s", tenantID, spaceID, episodeID, participantID)
	}
	for _, data := range fixture.forbiddenData() {
		if strings.Contains(response.Body.String()+response.Header().Get("Location"), data) {
			t.Fatalf("upload leaked foreign data %q", data)
		}
	}
	// Strict JSON decoding must reject identity overrides before reserving data.
	var before, after int
	if err := tx.QueryRow(t.Context(), `select count(*) from sync_chat_attachments`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	body := `{"clientAttachmentId":"matrix-body-injection-0001","fileName":"note.txt","mimeType":"text/plain","byteLength":1,"sha256":"` + strings.Repeat("00", 32) + `","tenant_id":"` + foreign.TenantID.String() + `","space_id":"` + foreign.SpaceID.String() + `","episode_id":"` + foreign.EpisodeID.String() + `","participant_id":"` + foreign.ParticipantID.String() + `"}`
	injection := httptest.NewRequest(http.MethodPost, request.URL.String(), strings.NewReader(body))
	injection.Header.Set("Authorization", "Bearer "+fixture.syncToken)
	assertMatrixDenial(t, router, injection, http.StatusBadRequest, fixture.forbiddenData())
	if err := tx.QueryRow(t.Context(), `select count(*) from sync_chat_attachments`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatalf("rejected body injection reserved an upload: %d -> %d", before, after)
	}
}
