package httpapi_test

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/participantaccess"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/rooms"
	"github.com/q9labs/chalk/apps/api/internal/sessionlifecycle"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const validSessionPolicyJSON = `"admission_policy":"open","host_exit_policy":"require_transfer","role_capabilities":{"host":["subscribe","transferHost","endMeeting"],"cohost":["subscribe"],"participant":["subscribe"]},"maximum_duration_seconds":3600`

type lifecycleService struct {
	create   func(context.Context, sessionlifecycle.CreateSessionInput) (sessionlifecycle.Session, error)
	admit    func(context.Context, sessionlifecycle.AdmitParticipantInput) (sessionlifecycle.Admission, error)
	remove   func(context.Context, sessionlifecycle.RequestParticipantRemovalInput) (sessionlifecycle.Removal, error)
	end      func(context.Context, sessionlifecycle.RequestSessionEndInput) (sessionlifecycle.EndRequest, error)
	transfer func(context.Context, sessionlifecycle.TransferHostInput) (sessionlifecycle.ControlRequest, error)
	deadline func(context.Context, sessionlifecycle.SetDeadlineInput) (sessionlifecycle.ControlRequest, error)
}

type syncTokenIssuerFunc func(context.Context, synctokens.Input) (synctokens.Token, error)

func (f syncTokenIssuerFunc) Issue(ctx context.Context, input synctokens.Input) (synctokens.Token, error) {
	return f(ctx, input)
}

type syncTokenRefreshIssuerFunc func(context.Context, synctokens.SubjectKey) (synctokens.Token, error)

func (f syncTokenRefreshIssuerFunc) IssueForParticipant(ctx context.Context, key synctokens.SubjectKey) (synctokens.Token, error) {
	return f(ctx, key)
}

type participantMediaVerifierFunc func(context.Context, string) (participantaccess.Subject, error)

func (f participantMediaVerifierFunc) Verify(ctx context.Context, token string) (participantaccess.Subject, error) {
	return f(ctx, token)
}

type activeParticipantAuthorizerFunc func(context.Context, participantaccess.Subject) (bool, error)

func (f activeParticipantAuthorizerFunc) AuthorizeActiveParticipant(ctx context.Context, subject participantaccess.Subject) (bool, error) {
	return f(ctx, subject)
}

type mediaPlaneResolverFunc func(context.Context, tenants.Tenant, rooms.Room) (*mediaplane.Service, error)

func (f mediaPlaneResolverFunc) Resolve(ctx context.Context, tenant tenants.Tenant, room rooms.Room) (*mediaplane.Service, error) {
	return f(ctx, tenant, room)
}

type mediaPublicationRegistryStub struct {
	record  func(context.Context, mediapublications.RecordInput) ([]mediapublications.PublishedReference, error)
	prepare func(context.Context, mediapublications.CloseInput) (mediapublications.CloseDecision, error)
	close   func(context.Context, mediapublications.CloseInput) error
	latest  func(context.Context, utilities.ID, utilities.ID) (mediapublications.Snapshot, error)
}

func (s mediaPublicationRegistryStub) RecordPublishedTracks(ctx context.Context, input mediapublications.RecordInput) ([]mediapublications.PublishedReference, error) {
	return s.record(ctx, input)
}

func (s mediaPublicationRegistryStub) PrepareClose(ctx context.Context, input mediapublications.CloseInput) (mediapublications.CloseDecision, error) {
	if s.prepare == nil {
		return mediapublications.CloseDecision{ProviderCloseRequired: true}, nil
	}
	return s.prepare(ctx, input)
}

func (s mediaPublicationRegistryStub) RecordClosedPublication(ctx context.Context, input mediapublications.CloseInput) error {
	if s.close == nil {
		return nil
	}
	return s.close(ctx, input)
}

func (s mediaPublicationRegistryStub) Latest(ctx context.Context, tenantID, sessionID utilities.ID) (mediapublications.Snapshot, error) {
	return s.latest(ctx, tenantID, sessionID)
}

type lifecycleMediaPlane struct {
	ensureInput      mediaplane.EnsureSessionInput
	joinInput        mediaplane.CreateJoinInput
	tracksInput      mediaplane.TracksRequest
	closeTracksInput mediaplane.CloseTracksRequest
	renegotiateInput mediaplane.RenegotiateRequest
	removeInput      mediaplane.RemoveParticipantInput
	endInput         mediaplane.EndSessionInput
	joinErr          error
	removeErr        error
	endErr           error
}

func (p *lifecycleMediaPlane) EnsureSession(_ context.Context, input mediaplane.EnsureSessionInput) (mediaplane.Session, error) {
	p.ensureInput = input
	return mediaplane.Session{Provider: input.Provider, Ref: "media-session-ref"}, nil
}

func (p *lifecycleMediaPlane) CreateJoin(_ context.Context, input mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	p.joinInput = input
	if p.joinErr != nil {
		return mediaplane.Join{}, p.joinErr
	}
	return mediaplane.Join{Provider: input.Provider, ParticipantRef: "media-participant-ref", ClientPayload: map[string]any{"token": "opaque-token"}}, nil
}

func (p *lifecycleMediaPlane) ResumeJoin(_ context.Context, input mediaplane.ResumeJoinInput) (mediaplane.Join, error) {
	return mediaplane.Join{Provider: input.Provider, ParticipantRef: input.ExternalParticipantID, ClientPayload: map[string]any{"connectionId": input.ConnectionRef}}, nil
}

func (p *lifecycleMediaPlane) RemoveParticipant(_ context.Context, input mediaplane.RemoveParticipantInput) error {
	p.removeInput = input
	return p.removeErr
}

func (p *lifecycleMediaPlane) EndSession(_ context.Context, input mediaplane.EndSessionInput) error {
	p.endInput = input
	return p.endErr
}

func (*lifecycleMediaPlane) SessionUsage(context.Context, mediaplane.SessionUsageInput) (mediaplane.Usage, error) {
	return mediaplane.Usage{}, nil
}

func (p *lifecycleMediaPlane) AddTracks(_ context.Context, input mediaplane.TracksRequest) (mediaplane.TracksResponse, error) {
	p.tracksInput = input
	return mediaplane.TracksResponse{SessionDescription: &mediaplane.SessionDescription{Type: "answer", SDP: "provider-answer"}, Tracks: append([]mediaplane.Track(nil), input.Tracks...)}, nil
}

func (p *lifecycleMediaPlane) CloseTracks(_ context.Context, input mediaplane.CloseTracksRequest) (mediaplane.CloseTracksResponse, error) {
	p.closeTracksInput = input
	return mediaplane.CloseTracksResponse{Tracks: input.Tracks}, nil
}

func (p *lifecycleMediaPlane) Renegotiate(_ context.Context, input mediaplane.RenegotiateRequest) error {
	p.renegotiateInput = input
	return nil
}

type mediaRoomService struct {
	guardedRoomService
	room rooms.Room
}

func (s mediaRoomService) GetRoom(context.Context, utilities.ID, utilities.ID) (rooms.Room, error) {
	return s.room, nil
}

func (s mediaRoomService) GetSession(_ context.Context, tenantID utilities.ID, roomID utilities.ID, sessionID utilities.ID) (rooms.Session, error) {
	return rooms.Session{ID: sessionID, TenantID: tenantID, RoomID: roomID, Status: rooms.SessionStatusActive}, nil
}

func (s lifecycleService) CreateSession(ctx context.Context, input sessionlifecycle.CreateSessionInput) (sessionlifecycle.Session, error) {
	if s.create == nil {
		return sessionlifecycle.Session{}, errors.New("unexpected lifecycle create")
	}
	return s.create(ctx, input)
}

func (s lifecycleService) AdmitParticipant(ctx context.Context, input sessionlifecycle.AdmitParticipantInput) (sessionlifecycle.Admission, error) {
	if s.admit == nil {
		return sessionlifecycle.Admission{}, errors.New("unexpected lifecycle admission")
	}
	return s.admit(ctx, input)
}

func (s lifecycleService) RequestParticipantRemoval(ctx context.Context, input sessionlifecycle.RequestParticipantRemovalInput) (sessionlifecycle.Removal, error) {
	if s.remove == nil {
		return sessionlifecycle.Removal{}, errors.New("unexpected lifecycle removal")
	}
	return s.remove(ctx, input)
}

func (s lifecycleService) RequestSessionEnd(ctx context.Context, input sessionlifecycle.RequestSessionEndInput) (sessionlifecycle.EndRequest, error) {
	if s.end == nil {
		return sessionlifecycle.EndRequest{}, errors.New("unexpected lifecycle end")
	}
	return s.end(ctx, input)
}

func (s lifecycleService) TransferHost(ctx context.Context, input sessionlifecycle.TransferHostInput) (sessionlifecycle.ControlRequest, error) {
	if s.transfer == nil {
		return sessionlifecycle.ControlRequest{}, errors.New("unexpected host transfer")
	}
	return s.transfer(ctx, input)
}

func (s lifecycleService) SetDeadline(ctx context.Context, input sessionlifecycle.SetDeadlineInput) (sessionlifecycle.ControlRequest, error) {
	if s.deadline == nil {
		return sessionlifecycle.ControlRequest{}, errors.New("unexpected deadline change")
	}
	return s.deadline(ctx, input)
}

func TestCreateRoomSessionUsesLifecycleService(t *testing.T) {
	tenantID := mustTenantID(t, "11111111-1111-4111-8111-111111111111")
	roomID := mustTenantID(t, "22222222-2222-4222-8222-222222222222")
	sessionID := mustTenantID(t, "33333333-3333-4333-8333-333333333333")
	created := false
	read := false
	request := bearerRequestWithBody(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions", "raw-session-token", `{"metadata":{"topic":"planning"},`+validSessionPolicyJSON+`}`)
	request.Header.Set("Idempotency-Key", "create-request-key-0001")
	res := requestWithOptionsAndRequest(t, request, authenticatedOptions(t, httpapi.Options{
		Rooms: roomService{getSession: func(_ context.Context, gotTenantID, gotRoomID, gotSessionID utilities.ID) (rooms.Session, error) {
			read = true
			if gotTenantID != tenantID || gotRoomID != roomID || gotSessionID != sessionID {
				t.Fatalf("read ids = %s/%s/%s", gotTenantID, gotRoomID, gotSessionID)
			}
			now := time.Date(2026, 7, 12, 12, 0, 0, 0, time.UTC)
			return rooms.Session{ID: sessionID, TenantID: tenantID, RoomID: roomID, Status: rooms.SessionStatusActive, Metadata: []byte(`{"topic":"planning"}`), CreatedAt: now, UpdatedAt: now}, nil
		}},
		SessionLifecycle: lifecycleService{create: func(_ context.Context, input sessionlifecycle.CreateSessionInput) (sessionlifecycle.Session, error) {
			created = true
			if input.TenantID != tenantID || input.RoomID != roomID || input.Request.Key != "create-request-key-0001" || input.HostExitPolicy != "require_transfer" || input.MaximumDurationSeconds != 3600 || input.MaximumDurationCeilingSeconds != 86400 || input.DeadlineAt.IsZero() {
				t.Fatalf("lifecycle create input = %#v", input)
			}
			if input.RoleCapabilities["host"][1] != "transferHost" {
				t.Fatalf("role capabilities = %#v", input.RoleCapabilities)
			}
			return sessionlifecycle.Session{ID: sessionID}, nil
		}},
	}))

	if res.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", res.Code, res.Body.String())
	}
	if !created || !read {
		t.Fatalf("lifecycle created=%v room read=%v", created, read)
	}
}

func TestCreateRoomSessionRequiresValidIdempotencyKey(t *testing.T) {
	for _, key := range []string{"", "short", "123456789012345!"} {
		request := bearerRequestWithBody(http.MethodPost, "/v1/tenants/11111111-1111-4111-8111-111111111111/rooms/22222222-2222-4222-8222-222222222222/sessions", "raw-session-token", `{`+validSessionPolicyJSON+`}`)
		request.Header.Set("Idempotency-Key", key)
		res := requestWithOptionsAndRequest(t, request, authenticatedOptions(t, httpapi.Options{Rooms: guardedRoomService{}, SessionLifecycle: sessionlifecycle.NewService(&captureLifecycleRepository{})}))
		if res.Code != http.StatusBadRequest {
			t.Fatalf("key %q status = %d, want 400; body=%s", key, res.Code, res.Body.String())
		}
		assertErrorCode(t, res, "invalid_idempotency_key")
	}
}

func TestCreateRoomSessionRejectsMissingV3Policy(t *testing.T) {
	request := bearerRequestWithBody(http.MethodPost, "/v1/tenants/11111111-1111-4111-8111-111111111111/rooms/22222222-2222-4222-8222-222222222222/sessions", "raw-session-token", `{}`)
	request.Header.Set("Idempotency-Key", "create-request-key-0001")
	res := requestWithOptionsAndRequest(t, request, authenticatedOptions(t, httpapi.Options{Rooms: guardedRoomService{}, SessionLifecycle: sessionlifecycle.NewService(&captureLifecycleRepository{})}))
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", res.Code, res.Body.String())
	}
	assertErrorCode(t, res, "invalid_request")
}

func TestCreateRoomSessionRejectsClientOwnedCeilingAndDeadline(t *testing.T) {
	for _, field := range []string{`,"maximum_duration_ceiling_seconds":7200`, `,"deadline_at":"2026-07-13T06:30:00Z"`} {
		request := bearerRequestWithBody(http.MethodPost, "/v1/tenants/11111111-1111-4111-8111-111111111111/rooms/22222222-2222-4222-8222-222222222222/sessions", "raw-session-token", `{`+validSessionPolicyJSON+field+`}`)
		request.Header.Set("Idempotency-Key", "create-request-key-0001")
		res := requestWithOptionsAndRequest(t, request, authenticatedOptions(t, httpapi.Options{Rooms: guardedRoomService{}, SessionLifecycle: lifecycleService{}}))
		if res.Code != http.StatusBadRequest {
			t.Fatalf("field %s status = %d, want 400; body=%s", field, res.Code, res.Body.String())
		}
		assertErrorCode(t, res, "invalid_request")
	}
}

type captureLifecycleRepository struct{}

func (*captureLifecycleRepository) CreateSession(context.Context, sessionlifecycle.CreateSessionInput) (sessionlifecycle.Session, error) {
	return sessionlifecycle.Session{}, errors.New("repository must not be called")
}

func (*captureLifecycleRepository) AdmitParticipant(context.Context, sessionlifecycle.AdmitParticipantInput) (sessionlifecycle.Admission, error) {
	return sessionlifecycle.Admission{}, errors.New("unexpected admission")
}

func (*captureLifecycleRepository) RequestParticipantRemoval(context.Context, sessionlifecycle.RequestParticipantRemovalInput) (sessionlifecycle.Removal, error) {
	return sessionlifecycle.Removal{}, errors.New("unexpected removal")
}

func (*captureLifecycleRepository) RequestSessionEnd(context.Context, sessionlifecycle.RequestSessionEndInput) (sessionlifecycle.EndRequest, error) {
	return sessionlifecycle.EndRequest{}, errors.New("unexpected end")
}

func TestAdmitParticipantPassesIdempotencyKeyToLifecycleService(t *testing.T) {
	tenantID := mustTenantID(t, "11111111-1111-4111-8111-111111111111")
	roomID := mustTenantID(t, "22222222-2222-4222-8222-222222222222")
	sessionID := mustTenantID(t, "33333333-3333-4333-8333-333333333333")
	participantID := mustTenantID(t, "44444444-4444-4444-8444-444444444444")
	intentID := mustTenantID(t, "55555555-5555-4555-8555-555555555555")
	request := bearerRequestWithBody(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions/"+sessionID.String()+"/participants", "raw-session-token", `{"participant_session_id":"`+participantID.String()+`","name":"Ada","initial_role":"cohost","eligible_roles":["cohost","participant"]}`)
	request.Header.Set("Idempotency-Key", "admit-request-key-0001")
	res := requestWithOptionsAndRequest(t, request, authenticatedOptions(t, httpapi.Options{
		SessionLifecycle: lifecycleService{admit: func(_ context.Context, input sessionlifecycle.AdmitParticipantInput) (sessionlifecycle.Admission, error) {
			if input.Request.Key != "admit-request-key-0001" || input.ParticipantID != participantID || input.SessionID != sessionID || input.InitialRole != "cohost" || len(input.EligibleRoles) != 2 {
				t.Fatalf("admission input = %#v", input)
			}
			now := time.Date(2026, 7, 12, 12, 0, 0, 0, time.UTC)
			return sessionlifecycle.Admission{
				Participant: sessionlifecycle.Participant{ID: participantID, TenantID: tenantID, RoomID: roomID, SessionID: sessionID, Generation: 1, Status: sessionlifecycle.ParticipantStatusJoining},
				Intent:      sessionlifecycle.Intent{ID: intentID, RequestKey: input.Request.Key, IntentName: sessionlifecycle.IntentParticipantJoined, ParticipantID: participantID, ParticipantGeneration: 1, Status: sessionlifecycle.IntentStatusPending, CreatedAt: now},
			}, nil
		}},
		SyncTokens: syncTokenIssuerFunc(func(_ context.Context, input synctokens.Input) (synctokens.Token, error) {
			if input.ParticipantID != participantID || input.AdmissionLifecycleIntentID != intentID || input.ParticipantGeneration != 1 {
				t.Fatalf("sync token input = %#v", input)
			}
			if input.InitialRole != "cohost" || len(input.EligibleRoles) != 2 || input.EligibleRoles[1] != "participant" {
				t.Fatalf("authority envelope = %q %#v", input.InitialRole, input.EligibleRoles)
			}
			return synctokens.Token{Value: "signed-sync-token", ExpiresAt: time.Date(2026, 7, 12, 12, 5, 0, 0, time.UTC)}, nil
		}),
	}))

	if res.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", res.Code, res.Body.String())
	}
	var body struct {
		SyncToken       string `json:"sync_token"`
		ExpiresAt       string `json:"expires_at"`
		LifecycleIntent struct {
			ID                           string `json:"id"`
			RequestKey                   string `json:"request_key"`
			ParticipantSessionID         string `json:"participant_session_id"`
			ParticipantSessionGeneration int64  `json:"participant_session_generation"`
			Status                       string `json:"status"`
		} `json:"lifecycle_intent"`
	}
	decodeJSON(t, res, &body)
	if body.SyncToken != "signed-sync-token" || body.ExpiresAt != "2026-07-12T12:05:00Z" {
		t.Fatalf("token response = %q %q", body.SyncToken, body.ExpiresAt)
	}
	if body.LifecycleIntent.ID != intentID.String() || body.LifecycleIntent.RequestKey != "admit-request-key-0001" || body.LifecycleIntent.ParticipantSessionID != participantID.String() || body.LifecycleIntent.ParticipantSessionGeneration != 1 || body.LifecycleIntent.Status != "pending" {
		t.Fatalf("lifecycle intent response = %#v", body.LifecycleIntent)
	}
}

func TestApprovalAdmissionReturnsPendingWithoutMediaJoinOrSyncToken(t *testing.T) {
	tenantID := mustTenantID(t, "11111111-1111-4111-8111-111111111111")
	roomID := mustTenantID(t, "22222222-2222-4222-8222-222222222222")
	sessionID := mustTenantID(t, "33333333-3333-4333-8333-333333333333")
	participantID := mustTenantID(t, "44444444-4444-4444-8444-444444444444")
	intentID := mustTenantID(t, "55555555-5555-4555-8555-555555555555")
	requestID := mustTenantID(t, "66666666-6666-4666-8666-666666666666")
	expiresAt := time.Date(2026, 7, 12, 12, 5, 0, 0, time.UTC)
	request := bearerRequestWithBody(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions/"+sessionID.String()+"/participants", "raw-session-token", `{"participant_session_id":"`+participantID.String()+`","name":"Ada","initial_role":"participant","eligible_roles":["participant"]}`)
	request.Header.Set("Idempotency-Key", "approval-admit-key-0001")
	res := requestWithOptionsAndRequest(t, request, authenticatedOptions(t, httpapi.Options{
		SessionLifecycle: lifecycleService{admit: func(_ context.Context, input sessionlifecycle.AdmitParticipantInput) (sessionlifecycle.Admission, error) {
			return sessionlifecycle.Admission{
				Participant:      sessionlifecycle.Participant{ID: participantID, TenantID: tenantID, RoomID: roomID, SessionID: sessionID, Generation: 1, Status: sessionlifecycle.ParticipantStatusJoining},
				Intent:           sessionlifecycle.Intent{ID: intentID, RequestKey: input.Request.Key, IntentName: sessionlifecycle.IntentAdmissionRequested, Status: sessionlifecycle.IntentStatusPending, CreatedAt: expiresAt.Add(-time.Minute)},
				AdmissionRequest: &sessionlifecycle.AdmissionRequest{ID: requestID, Status: "pending", ExpiresAt: expiresAt},
			}, nil
		}},
		SyncTokens: syncTokenIssuerFunc(func(context.Context, synctokens.Input) (synctokens.Token, error) {
			t.Fatal("approval admission issued a sync token")
			return synctokens.Token{}, nil
		}),
		MediaPlane: mediaPlaneResolverFunc(func(context.Context, tenants.Tenant, rooms.Room) (*mediaplane.Service, error) {
			t.Fatal("approval admission resolved the media plane")
			return nil, nil
		}),
	}))
	if res.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", res.Code, res.Body.String())
	}
	var body struct {
		SyncToken       string `json:"sync_token"`
		MediaPlane      any    `json:"media_plane"`
		LifecycleIntent struct {
			ID         string `json:"id"`
			IntentName string `json:"intent_name"`
		} `json:"lifecycle_intent"`
		AdmissionRequest struct {
			ID        string `json:"id"`
			Status    string `json:"status"`
			ExpiresAt string `json:"expires_at"`
		} `json:"admission_request"`
	}
	decodeJSON(t, res, &body)
	if body.SyncToken != "" || body.MediaPlane != nil {
		t.Fatalf("pending approval exposed join credentials: %#v", body)
	}
	if body.LifecycleIntent.ID != intentID.String() || body.LifecycleIntent.IntentName != sessionlifecycle.IntentAdmissionRequested {
		t.Fatalf("approval lifecycle intent = %#v", body.LifecycleIntent)
	}
	if body.AdmissionRequest.ID != requestID.String() || body.AdmissionRequest.Status != "pending" || body.AdmissionRequest.ExpiresAt != "2026-07-12T12:05:00Z" {
		t.Fatalf("approval request response = %#v", body.AdmissionRequest)
	}
}

func TestAdmitParticipantRejectsLegacyCapabilitiesWithoutSignedRoles(t *testing.T) {
	request := bearerRequestWithBody(http.MethodPost, "/v1/tenants/11111111-1111-4111-8111-111111111111/rooms/22222222-2222-4222-8222-222222222222/sessions/33333333-3333-4333-8333-333333333333/participants", "raw-session-token", `{"participant_session_id":"44444444-4444-4444-8444-444444444444","name":"Ada","capabilities":["endMeeting"]}`)
	request.Header.Set("Idempotency-Key", "admit-request-key-0001")
	res := requestWithOptionsAndRequest(t, request, authenticatedOptions(t, httpapi.Options{SessionLifecycle: sessionlifecycle.NewService(&captureLifecycleRepository{})}))
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", res.Code, res.Body.String())
	}
	assertErrorCode(t, res, "invalid_request")
}

func TestAdmitParticipantCreatesMediaJoin(t *testing.T) {
	tenantID := mustTenantID(t, "11111111-1111-4111-8111-111111111111")
	roomID := mustTenantID(t, "22222222-2222-4222-8222-222222222222")
	sessionID := mustTenantID(t, "33333333-3333-4333-8333-333333333333")
	participantID := mustTenantID(t, "44444444-4444-4444-8444-444444444444")
	intentID := mustTenantID(t, "55555555-5555-4555-8555-555555555555")
	plane := &lifecycleMediaPlane{}
	request := bearerRequestWithBody(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions/"+sessionID.String()+"/participants", "raw-session-token", `{"participant_session_id":"`+participantID.String()+`","name":"Ada","initial_role":"participant","eligible_roles":["participant"]}`)
	request.Header.Set("Idempotency-Key", "media-join-request-0001")
	res := requestWithOptionsAndRequest(t, request, authenticatedOptions(t, httpapi.Options{
		Rooms: mediaRoomService{room: rooms.Room{ID: roomID, TenantID: tenantID, MediaPlane: "cf_rtk"}},
		Tenants: tenantService{getTenant: func(_ context.Context, id utilities.ID) (tenants.Tenant, error) {
			if id != tenantID {
				t.Fatalf("tenant id = %s, want %s", id, tenantID)
			}
			return tenants.Tenant{ID: tenantID}, nil
		}},
		MediaPlane: mediaPlaneResolverFunc(func(_ context.Context, tenant tenants.Tenant, room rooms.Room) (*mediaplane.Service, error) {
			if tenant.ID != tenantID || room.MediaPlane != "cf_rtk" {
				t.Fatalf("media resolution input = %#v / %#v", tenant, room)
			}
			service := mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareRTK, plane)
			return &service, nil
		}),
		SessionLifecycle: lifecycleService{admit: func(_ context.Context, input sessionlifecycle.AdmitParticipantInput) (sessionlifecycle.Admission, error) {
			return sessionlifecycle.Admission{
				Participant: sessionlifecycle.Participant{ID: participantID, TenantID: tenantID, RoomID: roomID, SessionID: sessionID, Generation: 1, Status: sessionlifecycle.ParticipantStatusJoining},
				Intent:      sessionlifecycle.Intent{ID: intentID, RequestKey: input.Request.Key, IntentName: sessionlifecycle.IntentParticipantJoined, ParticipantID: participantID, ParticipantGeneration: 1},
			}, nil
		}},
	}))

	if res.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", res.Code, res.Body.String())
	}
	if plane.ensureInput.Provider != mediaplane.ProviderCloudflareRTK || plane.ensureInput.SessionKey != sessionID.String() {
		t.Fatalf("ensure input = %#v", plane.ensureInput)
	}
	if plane.joinInput.Provider != mediaplane.ProviderCloudflareRTK || plane.joinInput.Session.Ref != "media-session-ref" || plane.joinInput.ExternalParticipantID != participantID.String() || plane.joinInput.ParticipantPreset != "contributor" {
		t.Fatalf("join input = %#v", plane.joinInput)
	}
	var body struct {
		MediaPlane *struct {
			Provider      string         `json:"provider"`
			ClientPayload map[string]any `json:"client_payload"`
		} `json:"media_plane"`
	}
	decodeJSON(t, res, &body)
	if body.MediaPlane == nil || body.MediaPlane.Provider != string(mediaplane.ProviderCloudflareRTK) || body.MediaPlane.ClientPayload["token"] != "opaque-token" {
		t.Fatalf("media response = %#v", body.MediaPlane)
	}
}

func TestCloudflareSFUSignalingRoutesProxyWithoutExposingSecret(t *testing.T) {
	tenantID := mustTenantID(t, "11111111-1111-4111-8111-111111111111")
	roomID := mustTenantID(t, "22222222-2222-4222-8222-222222222222")
	sessionID := mustTenantID(t, "33333333-3333-4333-8333-333333333333")
	participantID := mustTenantID(t, "44444444-4444-4444-8444-444444444444")
	plane := &lifecycleMediaPlane{}
	publicationID := "chalk_pub_v1." + base64.RawURLEncoding.EncodeToString([]byte(`{"c":"connection_123","m":"0","t":"camera-track","g":1}`))
	var recorded mediapublications.RecordInput
	var prepared mediapublications.CloseInput
	var closed mediapublications.CloseInput
	var prepareErr error
	options := authenticatedOptions(t, httpapi.Options{
		ParticipantMediaVerify: participantMediaVerifierFunc(func(context.Context, string) (participantaccess.Subject, error) {
			return participantaccess.Subject{
				TenantID: tenantID, RoomID: roomID, SessionID: sessionID, ParticipantSessionID: participantID,
				ParticipantGeneration: 1, Provider: participantaccess.ProviderCloudflareSFU, CloudflareConnectionID: "connection_123",
			}, nil
		}),
		ParticipantMediaActive: activeParticipantAuthorizerFunc(func(context.Context, participantaccess.Subject) (bool, error) { return true, nil }),
		Rooms:                  mediaRoomService{room: rooms.Room{ID: roomID, TenantID: tenantID, MediaPlane: "cf_sfu"}},
		Tenants: tenantService{getTenant: func(context.Context, utilities.ID) (tenants.Tenant, error) {
			return tenants.Tenant{ID: tenantID}, nil
		}},
		MediaPlane: mediaPlaneResolverFunc(func(context.Context, tenants.Tenant, rooms.Room) (*mediaplane.Service, error) {
			service := mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareSFU, plane)
			return &service, nil
		}),
		MediaPublications: mediaPublicationRegistryStub{
			record: func(_ context.Context, input mediapublications.RecordInput) ([]mediapublications.PublishedReference, error) {
				recorded = input
				return []mediapublications.PublishedReference{{Source: "camera", MID: "0", TrackName: "camera-track", PublicationID: publicationID}}, nil
			},
			prepare: func(_ context.Context, input mediapublications.CloseInput) (mediapublications.CloseDecision, error) {
				prepared = input
				if prepareErr != nil {
					return mediapublications.CloseDecision{}, prepareErr
				}
				return mediapublications.CloseDecision{ProviderCloseRequired: true}, nil
			},
			close: func(_ context.Context, input mediapublications.CloseInput) error {
				closed = input
				return nil
			},
			latest: func(context.Context, utilities.ID, utilities.ID) (mediapublications.Snapshot, error) {
				return mediapublications.Snapshot{Incarnation: 1, Sequence: 2, Publications: []provideroperations.Publication{{ParticipantSessionID: participantID, Source: "camera", Enabled: true, PublicationID: publicationID}}}, nil
			},
		},
	})
	basePath := "/v1/tenants/" + tenantID.String() + "/rooms/" + roomID.String() + "/sessions/" + sessionID.String() + "/participants/" + participantID.String() + "/media/sfu/"

	tracksRequest := bearerRequestWithBody(http.MethodPost, basePath+"tracks", "raw-session-token", `{"connection_id":"connection_123","session_description":{"type":"offer","sdp":"offer-sdp"},"tracks":[{"location":"local","mid":"0","trackName":"camera-track","source":"camera"}]}`)
	tracksResponse := requestWithOptionsAndRequest(t, tracksRequest, options)
	if tracksResponse.Code != http.StatusOK {
		t.Fatalf("tracks status = %d, want 200; body=%s", tracksResponse.Code, tracksResponse.Body.String())
	}
	if plane.tracksInput.ConnectionID != "connection_123" || plane.tracksInput.Tracks[0].TrackName != "camera-track" {
		t.Fatalf("tracks input = %#v", plane.tracksInput)
	}
	if recorded.ParticipantSessionID != participantID || recorded.Tracks[0].Source != "camera" {
		t.Fatalf("publication observation = %#v", recorded)
	}
	if strings.Contains(tracksResponse.Body.String(), "secret") || !strings.Contains(tracksResponse.Body.String(), "provider-answer") || !strings.Contains(tracksResponse.Body.String(), `"publication_id":"`+publicationID+`"`) {
		t.Fatalf("tracks response = %s", tracksResponse.Body.String())
	}

	closeRequest := bearerRequestWithBody(http.MethodPut, basePath+"tracks/close", "raw-session-token", `{"connection_id":"connection_123","tracks":[{"mid":"0","source":"camera","publication_id":"`+publicationID+`"}],"force":false}`)
	closeResponse := requestWithOptionsAndRequest(t, closeRequest, options)
	if closeResponse.Code != http.StatusOK {
		t.Fatalf("close status = %d, want 200; body=%s", closeResponse.Code, closeResponse.Body.String())
	}
	if plane.closeTracksInput.ConnectionID != "connection_123" || len(plane.closeTracksInput.Tracks) != 1 || prepared.PublicationID != publicationID || prepared.ParticipantGeneration != 1 || closed != prepared {
		t.Fatalf("close input/authorization/observation = %#v / %#v / %#v", plane.closeTracksInput, prepared, closed)
	}

	prepareErr = mediapublications.ErrInvalidPublication
	plane.closeTracksInput = mediaplane.CloseTracksRequest{}
	staleCloseResponse := requestWithOptionsAndRequest(t, closeRequest, options)
	if staleCloseResponse.Code != http.StatusBadRequest {
		t.Fatalf("stale close status = %d, want 400; body=%s", staleCloseResponse.Code, staleCloseResponse.Body.String())
	}
	if plane.closeTracksInput.ConnectionID != "" {
		t.Fatalf("stale close reached provider: %#v", plane.closeTracksInput)
	}

	renegotiateRequest := bearerRequestWithBody(http.MethodPost, basePath+"renegotiate", "raw-session-token", `{"connection_id":"connection_123","session_description":{"type":"answer","sdp":"browser-answer"}}`)
	renegotiateResponse := requestWithOptionsAndRequest(t, renegotiateRequest, options)
	if renegotiateResponse.Code != http.StatusOK {
		t.Fatalf("renegotiate status = %d, want 200; body=%s", renegotiateResponse.Code, renegotiateResponse.Body.String())
	}
	if plane.renegotiateInput.ConnectionID != "connection_123" || plane.renegotiateInput.SessionDescription.SDP != "browser-answer" {
		t.Fatalf("renegotiate input = %#v", plane.renegotiateInput)
	}

	publicationsRequest := bearerRequestWithBody(http.MethodGet, basePath+"publications", "raw-session-token", "")
	publicationsResponse := requestWithOptionsAndRequest(t, publicationsRequest, options)
	if publicationsResponse.Code != http.StatusOK || !strings.Contains(publicationsResponse.Body.String(), `"publication_id":"`+publicationID+`"`) {
		t.Fatalf("publications status = %d; body=%s", publicationsResponse.Code, publicationsResponse.Body.String())
	}
}

func TestAdmitParticipantMediaJoinFailureIsStable(t *testing.T) {
	tenantID := mustTenantID(t, "11111111-1111-4111-8111-111111111111")
	roomID := mustTenantID(t, "22222222-2222-4222-8222-222222222222")
	sessionID := mustTenantID(t, "33333333-3333-4333-8333-333333333333")
	participantID := mustTenantID(t, "44444444-4444-4444-8444-444444444444")
	plane := &lifecycleMediaPlane{joinErr: mediaplane.ErrProviderFailed}
	request := bearerRequestWithBody(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions/"+sessionID.String()+"/participants", "raw-session-token", `{"participant_session_id":"`+participantID.String()+`","name":"Ada","initial_role":"participant","eligible_roles":["participant"]}`)
	request.Header.Set("Idempotency-Key", "media-join-failure-0001")
	res := requestWithOptionsAndRequest(t, request, authenticatedOptions(t, httpapi.Options{
		Rooms:   mediaRoomService{room: rooms.Room{ID: roomID, TenantID: tenantID, MediaPlane: "cf_rtk"}},
		Tenants: tenantService{getTenant: func(context.Context, utilities.ID) (tenants.Tenant, error) { return tenants.Tenant{ID: tenantID}, nil }},
		MediaPlane: mediaPlaneResolverFunc(func(context.Context, tenants.Tenant, rooms.Room) (*mediaplane.Service, error) {
			service := mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareRTK, plane)
			return &service, nil
		}),
		SessionLifecycle: lifecycleService{admit: func(_ context.Context, input sessionlifecycle.AdmitParticipantInput) (sessionlifecycle.Admission, error) {
			return sessionlifecycle.Admission{Participant: sessionlifecycle.Participant{ID: participantID, TenantID: tenantID, RoomID: roomID, SessionID: sessionID, Generation: 1}}, nil
		}},
	}))

	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", res.Code, res.Body.String())
	}
	assertErrorCode(t, res, "media_plane_unavailable")
}

func TestRemoveParticipantAcceptanceDoesNotCallMediaPlane(t *testing.T) {
	tenantID := mustTenantID(t, "11111111-1111-4111-8111-111111111111")
	roomID := mustTenantID(t, "22222222-2222-4222-8222-222222222222")
	sessionID := mustTenantID(t, "33333333-3333-4333-8333-333333333333")
	participantID := mustTenantID(t, "44444444-4444-4444-8444-444444444444")
	operationID := mustTenantID(t, "55555555-5555-4555-8555-555555555555")
	createdAt := time.Date(2026, 7, 13, 6, 0, 0, 0, time.UTC)
	plane := &lifecycleMediaPlane{removeErr: mediaplane.ErrProviderFailed}
	request := bearerRequestWithBody(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions/"+sessionID.String()+"/participants/"+participantID.String()+"/remove", "raw-session-token", `{"participant_session_generation":1}`)
	request.Header.Set("Idempotency-Key", "media-remove-failure-0001")
	res := requestWithOptionsAndRequest(t, request, authenticatedOptions(t, httpapi.Options{
		Rooms:   mediaRoomService{room: rooms.Room{ID: roomID, TenantID: tenantID, MediaPlane: "cf_rtk"}},
		Tenants: tenantService{getTenant: func(context.Context, utilities.ID) (tenants.Tenant, error) { return tenants.Tenant{ID: tenantID}, nil }},
		MediaPlane: mediaPlaneResolverFunc(func(context.Context, tenants.Tenant, rooms.Room) (*mediaplane.Service, error) {
			service := mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareRTK, plane)
			return &service, nil
		}),
		SessionLifecycle: lifecycleService{remove: func(_ context.Context, input sessionlifecycle.RequestParticipantRemovalInput) (sessionlifecycle.Removal, error) {
			return sessionlifecycle.Removal{
				Session:     sessionlifecycle.Session{ID: input.SessionID},
				Participant: sessionlifecycle.Participant{ID: input.ParticipantID, TenantID: input.TenantID, RoomID: input.RoomID, SessionID: input.SessionID, Generation: input.ParticipantGeneration, Status: sessionlifecycle.ParticipantStatusLeaving},
				Intent:      sessionlifecycle.Intent{ID: operationID, RequestKey: input.Request.Key, IntentName: sessionlifecycle.OperationRemoveParticipant, ParticipantID: input.ParticipantID, ParticipantGeneration: input.ParticipantGeneration, Status: sessionlifecycle.IntentStatusPending, CreatedAt: createdAt},
			}, nil
		}},
	}))

	if res.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202; body=%s", res.Code, res.Body.String())
	}
	if plane.removeInput.SessionRef != "" || plane.removeInput.ParticipantRef != "" {
		t.Fatalf("API acceptance called remove provider: %#v", plane.removeInput)
	}
	var body map[string]any
	decodeJSON(t, res, &body)
	if _, advertised := body["lifecycle_intent"]; advertised {
		t.Fatalf("removal advertised obsolete lifecycle_intent: %#v", body)
	}
	operation, ok := body["external_operation"].(map[string]any)
	if !ok || operation["id"] != operationID.String() || operation["operation_name"] != sessionlifecycle.OperationRemoveParticipant || operation["target_participant_session_id"] != participantID.String() || operation["target_participant_session_generation"] != float64(1) {
		t.Fatalf("removal external operation = %#v", body["external_operation"])
	}
}

func TestEndSessionAcceptanceDoesNotCallMediaPlane(t *testing.T) {
	tenantID := mustTenantID(t, "11111111-1111-4111-8111-111111111111")
	roomID := mustTenantID(t, "22222222-2222-4222-8222-222222222222")
	sessionID := mustTenantID(t, "33333333-3333-4333-8333-333333333333")
	plane := &lifecycleMediaPlane{endErr: mediaplane.ErrProviderFailed}
	request := bearerRequestWithBody(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions/"+sessionID.String()+"/end", "raw-session-token", "")
	request.Header.Set("Idempotency-Key", "media-end-failure-0001")
	res := requestWithOptionsAndRequest(t, request, authenticatedOptions(t, httpapi.Options{
		Rooms:   mediaRoomService{room: rooms.Room{ID: roomID, TenantID: tenantID, MediaPlane: "cf_rtk"}},
		Tenants: tenantService{getTenant: func(context.Context, utilities.ID) (tenants.Tenant, error) { return tenants.Tenant{ID: tenantID}, nil }},
		MediaPlane: mediaPlaneResolverFunc(func(context.Context, tenants.Tenant, rooms.Room) (*mediaplane.Service, error) {
			service := mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareRTK, plane)
			return &service, nil
		}),
		SessionLifecycle: lifecycleService{end: func(_ context.Context, input sessionlifecycle.RequestSessionEndInput) (sessionlifecycle.EndRequest, error) {
			return sessionlifecycle.EndRequest{Session: sessionlifecycle.Session{ID: input.SessionID}}, nil
		}},
	}))

	if res.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202; body=%s", res.Code, res.Body.String())
	}
	if plane.endInput.SessionRef != "" {
		t.Fatalf("API acceptance called end provider: %#v", plane.endInput)
	}
}

func TestTenantControlRoutesProduceExternalOperations(t *testing.T) {
	tenantID := mustTenantID(t, "11111111-1111-4111-8111-111111111111")
	roomID := mustTenantID(t, "22222222-2222-4222-8222-222222222222")
	sessionID := mustTenantID(t, "33333333-3333-4333-8333-333333333333")
	participantID := mustTenantID(t, "44444444-4444-4444-8444-444444444444")
	operationID := mustTenantID(t, "55555555-5555-4555-8555-555555555555")
	createdAt := time.Date(2026, 7, 13, 6, 0, 0, 0, time.UTC)
	service := lifecycleService{
		transfer: func(_ context.Context, input sessionlifecycle.TransferHostInput) (sessionlifecycle.ControlRequest, error) {
			if input.ParticipantID != participantID || input.ParticipantGeneration != 7 || input.Request.Key != "tenant-transfer-key-0001" {
				t.Fatalf("transfer input = %#v", input)
			}
			return sessionlifecycle.ControlRequest{Session: sessionlifecycle.Session{ID: sessionID, Status: "active"}, Operation: sessionlifecycle.ExternalOperation{
				ID: operationID, RequestKey: input.Request.Key, OperationName: sessionlifecycle.OperationTenantTransferHost,
				TargetParticipantID: participantID, TargetGeneration: 7, Status: "pending", CreatedAt: createdAt,
			}}, nil
		},
		deadline: func(_ context.Context, input sessionlifecycle.SetDeadlineInput) (sessionlifecycle.ControlRequest, error) {
			if input.Deadline.UnixMilli() != time.Date(2026, 7, 13, 7, 0, 0, 0, time.UTC).UnixMilli() || input.Request.Key != "tenant-deadline-key-0001" {
				t.Fatalf("deadline input = %#v", input)
			}
			return sessionlifecycle.ControlRequest{Session: sessionlifecycle.Session{ID: sessionID, Status: "active"}, Operation: sessionlifecycle.ExternalOperation{
				ID: operationID, RequestKey: input.Request.Key, OperationName: sessionlifecycle.OperationTenantSetDeadline,
				DeadlineGeneration: 2, Status: "pending", CreatedAt: createdAt,
			}}, nil
		},
	}

	transferRequest := bearerRequestWithBody(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions/"+sessionID.String()+"/host/recover", "raw-session-token", `{"participant_session_id":"`+participantID.String()+`","participant_session_generation":7}`)
	transferRequest.Header.Set("Idempotency-Key", "tenant-transfer-key-0001")
	transferResponse := requestWithOptionsAndRequest(t, transferRequest, authenticatedOptions(t, httpapi.Options{SessionLifecycle: service}))
	if transferResponse.Code != http.StatusAccepted {
		t.Fatalf("transfer status = %d, want 202; body=%s", transferResponse.Code, transferResponse.Body.String())
	}
	var transferBody struct {
		Operation struct {
			OperationName                      string `json:"operation_name"`
			TargetParticipantSessionID         string `json:"target_participant_session_id"`
			TargetParticipantSessionGeneration int64  `json:"target_participant_session_generation"`
		} `json:"external_operation"`
	}
	decodeJSON(t, transferResponse, &transferBody)
	if transferBody.Operation.OperationName != sessionlifecycle.OperationTenantTransferHost || transferBody.Operation.TargetParticipantSessionID != participantID.String() || transferBody.Operation.TargetParticipantSessionGeneration != 7 {
		t.Fatalf("transfer response = %#v", transferBody)
	}

	deadlineRequest := bearerRequestWithBody(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions/"+sessionID.String()+"/deadline", "raw-session-token", `{"deadline_at":"2026-07-13T07:00:00Z"}`)
	deadlineRequest.Header.Set("Idempotency-Key", "tenant-deadline-key-0001")
	deadlineResponse := requestWithOptionsAndRequest(t, deadlineRequest, authenticatedOptions(t, httpapi.Options{SessionLifecycle: service}))
	if deadlineResponse.Code != http.StatusAccepted {
		t.Fatalf("deadline status = %d, want 202; body=%s", deadlineResponse.Code, deadlineResponse.Body.String())
	}
	var deadlineBody struct {
		Operation struct {
			OperationName      string `json:"operation_name"`
			DeadlineGeneration int64  `json:"deadline_generation"`
		} `json:"external_operation"`
	}
	decodeJSON(t, deadlineResponse, &deadlineBody)
	if deadlineBody.Operation.OperationName != sessionlifecycle.OperationTenantSetDeadline || deadlineBody.Operation.DeadlineGeneration != 2 {
		t.Fatalf("deadline response = %#v", deadlineBody)
	}
}

func TestIssueSyncTokenUsesPersistedParticipantSubject(t *testing.T) {
	tenantID := mustTenantID(t, "11111111-1111-4111-8111-111111111111")
	roomID := mustTenantID(t, "22222222-2222-4222-8222-222222222222")
	sessionID := mustTenantID(t, "33333333-3333-4333-8333-333333333333")
	participantID := mustTenantID(t, "44444444-4444-4444-8444-444444444444")

	res := authenticatedRequestWithOptions(t, http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions/"+sessionID.String()+"/participants/"+participantID.String()+"/sync-token", httpapi.Options{
		SyncTokenRefresh: syncTokenRefreshIssuerFunc(func(_ context.Context, key synctokens.SubjectKey) (synctokens.Token, error) {
			if key.TenantID != tenantID || key.RoomID != roomID || key.SessionID != sessionID || key.ParticipantID != participantID {
				t.Fatalf("subject key = %#v", key)
			}
			return synctokens.Token{Value: "refreshed-sync-token", ExpiresAt: time.Date(2026, 7, 12, 12, 5, 0, 0, time.UTC)}, nil
		}),
	})

	if res.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", res.Code, res.Body.String())
	}
	var body struct {
		SyncToken string `json:"sync_token"`
		ExpiresAt string `json:"expires_at"`
	}
	decodeJSON(t, res, &body)
	if body.SyncToken != "refreshed-sync-token" || body.ExpiresAt != "2026-07-12T12:05:00Z" {
		t.Fatalf("token response = %#v", body)
	}
}

func TestRoomSessionPatchRejectsLifecycleFields(t *testing.T) {
	res := authenticatedRequestWithOptionsAndBody(t, http.MethodPatch, "/v1/tenants/11111111-1111-4111-8111-111111111111/rooms/22222222-2222-4222-8222-222222222222/sessions/33333333-3333-4333-8333-333333333333", `{"status":"ended","ended_at":"2026-07-12T12:00:00Z"}`, httpapi.Options{Rooms: guardedRoomService{}})
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", res.Code, res.Body.String())
	}
	assertErrorCode(t, res, "invalid_request")
}
