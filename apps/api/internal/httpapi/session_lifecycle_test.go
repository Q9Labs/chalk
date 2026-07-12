package httpapi_test

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/rooms"
	"github.com/q9labs/chalk/apps/api/internal/sessionlifecycle"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type lifecycleService struct {
	create func(context.Context, sessionlifecycle.CreateSessionInput) (sessionlifecycle.Session, error)
	admit  func(context.Context, sessionlifecycle.AdmitParticipantInput) (sessionlifecycle.Admission, error)
	remove func(context.Context, sessionlifecycle.RequestParticipantRemovalInput) (sessionlifecycle.Removal, error)
	end    func(context.Context, sessionlifecycle.RequestSessionEndInput) (sessionlifecycle.EndRequest, error)
}

type syncTokenIssuerFunc func(context.Context, synctokens.Input) (synctokens.Token, error)

func (f syncTokenIssuerFunc) Issue(ctx context.Context, input synctokens.Input) (synctokens.Token, error) {
	return f(ctx, input)
}

type syncTokenRefreshIssuerFunc func(context.Context, synctokens.SubjectKey) (synctokens.Token, error)

func (f syncTokenRefreshIssuerFunc) IssueForParticipant(ctx context.Context, key synctokens.SubjectKey) (synctokens.Token, error) {
	return f(ctx, key)
}

type mediaPlaneResolverFunc func(context.Context, tenants.Tenant, rooms.Room) (*mediaplane.Service, error)

func (f mediaPlaneResolverFunc) Resolve(ctx context.Context, tenant tenants.Tenant, room rooms.Room) (*mediaplane.Service, error) {
	return f(ctx, tenant, room)
}

type lifecycleMediaPlane struct {
	ensureInput mediaplane.EnsureSessionInput
	joinInput   mediaplane.CreateJoinInput
	removeInput mediaplane.RemoveParticipantInput
	endInput    mediaplane.EndSessionInput
	joinErr     error
	removeErr   error
	endErr      error
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

type mediaRoomService struct {
	guardedRoomService
	room rooms.Room
}

func (s mediaRoomService) GetRoom(context.Context, utilities.ID, utilities.ID) (rooms.Room, error) {
	return s.room, nil
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

func TestCreateRoomSessionUsesLifecycleService(t *testing.T) {
	tenantID := mustTenantID(t, "11111111-1111-4111-8111-111111111111")
	roomID := mustTenantID(t, "22222222-2222-4222-8222-222222222222")
	sessionID := mustTenantID(t, "33333333-3333-4333-8333-333333333333")
	created := false
	read := false
	request := bearerRequestWithBody(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions", "raw-session-token", `{"metadata":{"topic":"planning"}}`)
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
			if input.TenantID != tenantID || input.RoomID != roomID || input.Request.Key != "create-request-key-0001" || input.InitialControl.Digest == ([32]byte{}) {
				t.Fatalf("lifecycle create input = %#v", input)
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
		request := bearerRequestWithBody(http.MethodPost, "/v1/tenants/11111111-1111-4111-8111-111111111111/rooms/22222222-2222-4222-8222-222222222222/sessions", "raw-session-token", `{}`)
		request.Header.Set("Idempotency-Key", key)
		res := requestWithOptionsAndRequest(t, request, authenticatedOptions(t, httpapi.Options{Rooms: guardedRoomService{}, SessionLifecycle: sessionlifecycle.NewService(&captureLifecycleRepository{})}))
		if res.Code != http.StatusBadRequest {
			t.Fatalf("key %q status = %d, want 400; body=%s", key, res.Code, res.Body.String())
		}
		assertErrorCode(t, res, "invalid_idempotency_key")
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
	request := bearerRequestWithBody(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions/"+sessionID.String()+"/participants", "raw-session-token", `{"participant_session_id":"`+participantID.String()+`","name":"Ada","capabilities":["control"]}`)
	request.Header.Set("Idempotency-Key", "admit-request-key-0001")
	res := requestWithOptionsAndRequest(t, request, authenticatedOptions(t, httpapi.Options{
		SessionLifecycle: lifecycleService{admit: func(_ context.Context, input sessionlifecycle.AdmitParticipantInput) (sessionlifecycle.Admission, error) {
			if input.Request.Key != "admit-request-key-0001" || input.ParticipantID != participantID || input.SessionID != sessionID {
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
			if len(input.Capabilities) != 1 || input.Capabilities[0] != "control:hand" {
				t.Fatalf("capabilities = %#v, want server policy", input.Capabilities)
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

func TestAdmitParticipantCreatesMediaJoin(t *testing.T) {
	tenantID := mustTenantID(t, "11111111-1111-4111-8111-111111111111")
	roomID := mustTenantID(t, "22222222-2222-4222-8222-222222222222")
	sessionID := mustTenantID(t, "33333333-3333-4333-8333-333333333333")
	participantID := mustTenantID(t, "44444444-4444-4444-8444-444444444444")
	intentID := mustTenantID(t, "55555555-5555-4555-8555-555555555555")
	plane := &lifecycleMediaPlane{}
	request := bearerRequestWithBody(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions/"+sessionID.String()+"/participants", "raw-session-token", `{"participant_session_id":"`+participantID.String()+`","name":"Ada"}`)
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

func TestAdmitParticipantMediaJoinFailureIsStable(t *testing.T) {
	tenantID := mustTenantID(t, "11111111-1111-4111-8111-111111111111")
	roomID := mustTenantID(t, "22222222-2222-4222-8222-222222222222")
	sessionID := mustTenantID(t, "33333333-3333-4333-8333-333333333333")
	participantID := mustTenantID(t, "44444444-4444-4444-8444-444444444444")
	plane := &lifecycleMediaPlane{joinErr: mediaplane.ErrProviderFailed}
	request := bearerRequestWithBody(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions/"+sessionID.String()+"/participants", "raw-session-token", `{"participant_session_id":"`+participantID.String()+`","name":"Ada"}`)
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

func TestRemoveParticipantMediaFailureDoesNotBlockLifecycle(t *testing.T) {
	tenantID := mustTenantID(t, "11111111-1111-4111-8111-111111111111")
	roomID := mustTenantID(t, "22222222-2222-4222-8222-222222222222")
	sessionID := mustTenantID(t, "33333333-3333-4333-8333-333333333333")
	participantID := mustTenantID(t, "44444444-4444-4444-8444-444444444444")
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
			return sessionlifecycle.Removal{Session: sessionlifecycle.Session{ID: input.SessionID}, Participant: sessionlifecycle.Participant{ID: input.ParticipantID}}, nil
		}},
	}))

	if res.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202; body=%s", res.Code, res.Body.String())
	}
	if plane.removeInput.SessionRef != sessionID.String() || plane.removeInput.ParticipantRef != participantID.String() {
		t.Fatalf("remove input = %#v", plane.removeInput)
	}
}

func TestEndSessionMediaFailureDoesNotBlockLifecycle(t *testing.T) {
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
	if plane.endInput.SessionRef != sessionID.String() {
		t.Fatalf("end input = %#v", plane.endInput)
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
