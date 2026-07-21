package httpapi_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/participantaccess"
	"github.com/q9labs/chalk/apps/api/internal/rooms"
	"github.com/q9labs/chalk/apps/api/internal/sessionlifecycle"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type participantAccessPlane struct {
	ensureCalls int
	createCalls int
	resumeCalls int
	createInput mediaplane.CreateJoinInput
	resumeInput mediaplane.ResumeJoinInput
	createJoin  mediaplane.Join
	resumeJoin  mediaplane.Join
}

type participantMediaIssuerFunc func(context.Context, participantaccess.Subject) (participantaccess.MediaCredential, error)

type participantGenerationAuthorizerFunc func(context.Context, synctokens.SubjectKey, int64) (bool, error)

type participantAccessHTTPResponse struct {
	Subject struct {
		TenantID              string `json:"tenant_id"`
		RoomID                string `json:"room_id"`
		SessionID             string `json:"session_id"`
		ParticipantSessionID  string `json:"participant_session_id"`
		ParticipantGeneration int64  `json:"participant_generation"`
	} `json:"subject"`
	Sync struct {
		Token string `json:"token"`
	} `json:"sync"`
	Media struct {
		Token         string         `json:"token"`
		Provider      string         `json:"provider"`
		ClientPayload map[string]any `json:"client_payload"`
	} `json:"media"`
}

func (f participantMediaIssuerFunc) Issue(ctx context.Context, subject participantaccess.Subject) (participantaccess.MediaCredential, error) {
	return f(ctx, subject)
}

func (f participantGenerationAuthorizerFunc) AuthorizeActiveParticipantGeneration(ctx context.Context, key synctokens.SubjectKey, generation int64) (bool, error) {
	return f(ctx, key, generation)
}

func (p *participantAccessPlane) EnsureSession(_ context.Context, input mediaplane.EnsureSessionInput) (mediaplane.Session, error) {
	p.ensureCalls++
	return mediaplane.Session{Provider: input.Provider, Ref: "media-session-ref"}, nil
}

func (p *participantAccessPlane) CreateJoin(_ context.Context, input mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	p.createCalls++
	p.createInput = input
	return p.createJoin, nil
}

func (p *participantAccessPlane) ResumeJoin(_ context.Context, input mediaplane.ResumeJoinInput) (mediaplane.Join, error) {
	p.resumeCalls++
	p.resumeInput = input
	return p.resumeJoin, nil
}

func (*participantAccessPlane) RemoveParticipant(context.Context, mediaplane.RemoveParticipantInput) error {
	return nil
}

func (*participantAccessPlane) EndSession(context.Context, mediaplane.EndSessionInput) error {
	return nil
}

func (*participantAccessPlane) SessionUsage(context.Context, mediaplane.SessionUsageInput) (mediaplane.Usage, error) {
	return mediaplane.Usage{}, nil
}

func TestAdmittedParticipantResponseIncludesAccessEnvelope(t *testing.T) {
	fixture := newParticipantAccessFixture(t)
	intentID := mustTenantID(t, "55555555-5555-4555-8555-555555555555")
	issuedSubject := participantaccess.Subject{}
	request := bearerRequestWithBody(http.MethodPost, fixture.participantsPath(), "raw-session-token", `{"participant_session_id":"`+fixture.participantID.String()+`","name":"Ada","initial_role":"participant","eligible_roles":["participant"]}`)
	request.Header.Set("Idempotency-Key", "admit-access-envelope-0001")
	response := requestWithOptionsAndRequest(t, request, authenticatedOptions(t, httpapi.Options{
		SessionLifecycle: lifecycleService{admit: func(_ context.Context, input sessionlifecycle.AdmitParticipantInput) (sessionlifecycle.Admission, error) {
			return sessionlifecycle.Admission{
				Participant: sessionlifecycle.Participant{ID: fixture.participantID, TenantID: fixture.tenantID, RoomID: fixture.roomID, SessionID: fixture.sessionID, Generation: 7, Status: sessionlifecycle.ParticipantStatusJoining},
				Intent: sessionlifecycle.Intent{
					ID: intentID, RequestKey: input.Request.Key, IntentName: sessionlifecycle.IntentParticipantJoined,
					ParticipantID: fixture.participantID, ParticipantGeneration: 7,
				},
			}, nil
		}},
		SyncTokens: syncTokenIssuerFunc(func(context.Context, synctokens.Input) (synctokens.Token, error) {
			return synctokens.Token{Value: "sync-access-token", ExpiresAt: time.Date(2026, 7, 21, 12, 5, 0, 0, time.UTC)}, nil
		}),
		ParticipantMediaIssuer: participantMediaIssuerFunc(func(_ context.Context, subject participantaccess.Subject) (participantaccess.MediaCredential, error) {
			issuedSubject = subject
			return participantaccess.MediaCredential{Token: "media-access-token", ExpiresAt: time.Date(2026, 7, 21, 12, 5, 0, 0, time.UTC)}, nil
		}),
		Rooms:      fixture.rooms(),
		Tenants:    fixture.tenants(),
		MediaPlane: fixture.resolver(),
	}))

	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", response.Code, response.Body.String())
	}
	var body struct {
		Access *participantAccessHTTPResponse `json:"access"`
	}
	decodeJSON(t, response, &body)
	if body.Access == nil {
		t.Fatal("admitted response omitted participant access")
	}
	if body.Access.Sync.Token != "sync-access-token" || body.Access.Media.Token != "media-access-token" || body.Access.Sync.Token == body.Access.Media.Token {
		t.Fatalf("access credentials = %#v", body.Access)
	}
	assertParticipantAccessSubject(t, body.Access, fixture, 7)
	if body.Access.Media.Provider != participantaccess.ProviderCloudflareSFU || body.Access.Media.ClientPayload["connectionId"] != "connection-new" || body.Access.Media.ClientPayload["sessionId"] != "provider-session" {
		t.Fatalf("media bootstrap = %#v", body.Access.Media)
	}
	if issuedSubject.CloudflareConnectionID != "connection-new" || issuedSubject.ParticipantGeneration != 7 {
		t.Fatalf("issued media subject = %#v", issuedSubject)
	}
	for _, secret := range []string{"raw-session-token", "provider-api-key-secret", "provider-private-key-secret"} {
		if strings.Contains(response.Body.String(), secret) {
			t.Fatalf("response leaked secret %q: %s", secret, response.Body.String())
		}
	}
}

func TestPendingApprovalResponseHasNoParticipantAccess(t *testing.T) {
	fixture := newParticipantAccessFixture(t)
	requestID := mustTenantID(t, "66666666-6666-4666-8666-666666666666")
	intentID := mustTenantID(t, "55555555-5555-4555-8555-555555555555")
	request := bearerRequestWithBody(http.MethodPost, fixture.participantsPath(), "raw-session-token", `{"participant_session_id":"`+fixture.participantID.String()+`","name":"Ada","initial_role":"participant","eligible_roles":["participant"]}`)
	request.Header.Set("Idempotency-Key", "pending-access-envelope-0001")
	response := requestWithOptionsAndRequest(t, request, authenticatedOptions(t, httpapi.Options{
		SessionLifecycle: lifecycleService{admit: func(context.Context, sessionlifecycle.AdmitParticipantInput) (sessionlifecycle.Admission, error) {
			return sessionlifecycle.Admission{
				Participant:      sessionlifecycle.Participant{ID: fixture.participantID, TenantID: fixture.tenantID, RoomID: fixture.roomID, SessionID: fixture.sessionID, Generation: 7},
				Intent:           sessionlifecycle.Intent{ID: intentID, IntentName: sessionlifecycle.IntentAdmissionRequested},
				AdmissionRequest: &sessionlifecycle.AdmissionRequest{ID: requestID, Status: "pending", ExpiresAt: time.Date(2026, 7, 21, 12, 5, 0, 0, time.UTC)},
			}, nil
		}},
		SyncTokens: syncTokenIssuerFunc(func(context.Context, synctokens.Input) (synctokens.Token, error) {
			t.Fatal("pending approval issued sync credentials")
			return synctokens.Token{}, nil
		}),
		ParticipantMediaIssuer: participantMediaIssuerFunc(func(context.Context, participantaccess.Subject) (participantaccess.MediaCredential, error) {
			t.Fatal("pending approval issued media credentials")
			return participantaccess.MediaCredential{}, nil
		}),
		MediaPlane: mediaPlaneResolverFunc(func(context.Context, tenants.Tenant, rooms.Room) (*mediaplane.Service, error) {
			t.Fatal("pending approval contacted media provider")
			return nil, nil
		}),
	}))

	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", response.Code, response.Body.String())
	}
	var body map[string]any
	decodeJSON(t, response, &body)
	if _, exists := body["access"]; exists {
		t.Fatalf("pending approval exposed participant access: %#v", body["access"])
	}
}

func TestParticipantAccessRefreshResumesCurrentMediaConnection(t *testing.T) {
	fixture := newParticipantAccessFixture(t)
	currentSubject := fixture.subject(7, "connection-current")
	fixture.plane.resumeJoin = mediaplane.Join{
		Provider: mediaplane.ProviderCloudflareSFU, ParticipantRef: fixture.participantID.String(),
		ClientPayload: map[string]any{"connectionId": "connection-current", "sessionId": "provider-session"},
	}
	verifiedToken := ""
	response := fixture.refresh(t, `{"participant_session_generation":7,"current_media_token":"current-media-token","replace_media_connection":false}`, httpapi.Options{
		ParticipantMediaVerify: participantMediaVerifierFunc(func(_ context.Context, token string) (participantaccess.Subject, error) {
			verifiedToken = token
			return currentSubject, nil
		}),
		ParticipantMediaActive: activeParticipantAuthorizerFunc(func(_ context.Context, subject participantaccess.Subject) (bool, error) {
			if subject != currentSubject {
				t.Fatalf("active subject = %#v, want %#v", subject, currentSubject)
			}
			return true, nil
		}),
	})

	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", response.Code, response.Body.String())
	}
	if verifiedToken != "current-media-token" {
		t.Fatalf("verified token = %q", verifiedToken)
	}
	if fixture.plane.createCalls != 0 || fixture.plane.resumeCalls != 1 || fixture.plane.resumeInput.ConnectionRef != "connection-current" || fixture.plane.resumeInput.ExternalParticipantID != fixture.participantID.String() {
		t.Fatalf("media calls create=%d resume=%d input=%#v", fixture.plane.createCalls, fixture.plane.resumeCalls, fixture.plane.resumeInput)
	}
	var body participantAccessHTTPResponse
	decodeJSON(t, response, &body)
	assertParticipantAccessSubject(t, &body, fixture, 7)
	if body.Media.ClientPayload["connectionId"] != "connection-current" || body.Sync.Token != "sync-refreshed-token" || body.Media.Token != "media-refreshed-token" {
		t.Fatalf("refreshed access = %#v", body)
	}
	if strings.Contains(response.Body.String(), "current-media-token") {
		t.Fatalf("response repeated current media credential: %s", response.Body.String())
	}
}

func TestParticipantAccessReplacementAuthorizesGenerationBeforeCreatingConnection(t *testing.T) {
	fixture := newParticipantAccessFixture(t)
	events := []string{}
	fixture.plane.createJoin = mediaplane.Join{
		Provider: mediaplane.ProviderCloudflareSFU, ParticipantRef: fixture.participantID.String(),
		ClientPayload: map[string]any{"connectionId": "connection-replacement", "sessionId": "provider-session"},
	}
	response := fixture.refresh(t, `{"participant_session_generation":7,"replace_media_connection":true}`, httpapi.Options{
		ParticipantGeneration: participantGenerationAuthorizerFunc(func(_ context.Context, key synctokens.SubjectKey, generation int64) (bool, error) {
			events = append(events, "generation")
			if key.ParticipantID != fixture.participantID || generation != 7 {
				t.Fatalf("generation authorization = %#v / %d", key, generation)
			}
			return true, nil
		}),
		MediaPlane: fixture.resolverWithEvent(&events),
	})

	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", response.Code, response.Body.String())
	}
	if strings.Join(events, ",") != "generation,resolver,create" {
		t.Fatalf("operation order = %q", strings.Join(events, ","))
	}
	if fixture.plane.createCalls != 1 || fixture.plane.resumeCalls != 0 || fixture.plane.createInput.ExternalParticipantID != fixture.participantID.String() {
		t.Fatalf("media calls create=%d resume=%d input=%#v", fixture.plane.createCalls, fixture.plane.resumeCalls, fixture.plane.createInput)
	}
	var body participantAccessHTTPResponse
	decodeJSON(t, response, &body)
	if body.Media.ClientPayload["connectionId"] != "connection-replacement" {
		t.Fatalf("replacement bootstrap = %#v", body.Media.ClientPayload)
	}
}

func TestParticipantAccessRefreshRejectsBeforeMediaProvider(t *testing.T) {
	fixture := newParticipantAccessFixture(t)
	wrongRoomID := mustTenantID(t, "77777777-7777-4777-8777-777777777777")
	tests := []struct {
		name       string
		body       string
		verify     participantMediaVerifierFunc
		active     activeParticipantAuthorizerFunc
		generation participantGenerationAuthorizerFunc
		wantCode   string
	}{
		{name: "missing current token", body: `{"participant_session_generation":7}`, wantCode: "invalid_request"},
		{name: "invalid current token", body: `{"participant_session_generation":7,"current_media_token":"invalid"}`, verify: func(context.Context, string) (participantaccess.Subject, error) {
			return participantaccess.Subject{}, participantaccess.ErrInvalidSignature
		}, wantCode: "invalid_request"},
		{name: "crossed audience", body: `{"participant_session_generation":7,"current_media_token":"sync-token"}`, verify: func(context.Context, string) (participantaccess.Subject, error) {
			return participantaccess.Subject{}, participantaccess.ErrInvalidAudience
		}, wantCode: "invalid_request"},
		{name: "stale generation", body: `{"participant_session_generation":7,"current_media_token":"stale"}`, verify: func(context.Context, string) (participantaccess.Subject, error) {
			return fixture.subject(6, "connection-current"), nil
		}, wantCode: "forbidden"},
		{name: "crossed route", body: `{"participant_session_generation":7,"current_media_token":"crossed-route"}`, verify: func(context.Context, string) (participantaccess.Subject, error) {
			subject := fixture.subject(7, "connection-current")
			subject.RoomID = wrongRoomID
			return subject, nil
		}, wantCode: "forbidden"},
		{name: "removed participant", body: `{"participant_session_generation":7,"current_media_token":"removed"}`, verify: func(context.Context, string) (participantaccess.Subject, error) {
			return fixture.subject(7, "connection-current"), nil
		}, active: func(context.Context, participantaccess.Subject) (bool, error) { return false, nil }, wantCode: "forbidden"},
		{name: "stale replacement generation", body: `{"participant_session_generation":7,"replace_media_connection":true}`, generation: func(context.Context, synctokens.SubjectKey, int64) (bool, error) {
			return false, nil
		}, wantCode: "forbidden"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			plane := &participantAccessPlane{}
			options := httpapi.Options{
				ParticipantMediaVerify: test.verify,
				ParticipantMediaActive: test.active,
				ParticipantGeneration:  test.generation,
				MediaPlane: mediaPlaneResolverFunc(func(context.Context, tenants.Tenant, rooms.Room) (*mediaplane.Service, error) {
					t.Fatal("rejected refresh contacted media provider")
					service := mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareSFU, plane)
					return &service, nil
				}),
			}
			response := fixture.refresh(t, test.body, options)
			if response.Code == http.StatusCreated {
				t.Fatalf("status = 201, want rejection; body=%s", response.Body.String())
			}
			assertErrorCode(t, response, test.wantCode)
			if plane.ensureCalls != 0 || plane.createCalls != 0 || plane.resumeCalls != 0 {
				t.Fatalf("rejected refresh used media plane: %#v", plane)
			}
		})
	}
}

type participantAccessFixture struct {
	tenantID      utilities.ID
	roomID        utilities.ID
	sessionID     utilities.ID
	participantID utilities.ID
	plane         *participantAccessPlane
}

func newParticipantAccessFixture(t *testing.T) participantAccessFixture {
	t.Helper()
	return participantAccessFixture{
		tenantID:      mustTenantID(t, "11111111-1111-4111-8111-111111111111"),
		roomID:        mustTenantID(t, "22222222-2222-4222-8222-222222222222"),
		sessionID:     mustTenantID(t, "33333333-3333-4333-8333-333333333333"),
		participantID: mustTenantID(t, "44444444-4444-4444-8444-444444444444"),
		plane: &participantAccessPlane{createJoin: mediaplane.Join{
			Provider: mediaplane.ProviderCloudflareSFU, ParticipantRef: "provider-participant",
			ClientPayload: map[string]any{"connectionId": "connection-new", "sessionId": "provider-session"},
		}},
	}
}

func (f participantAccessFixture) participantsPath() string {
	return "/v1/tenants/" + f.tenantID.String() + "/rooms/" + f.roomID.String() + "/sessions/" + f.sessionID.String() + "/participants"
}

func (f participantAccessFixture) accessPath() string {
	return f.participantsPath() + "/" + f.participantID.String() + "/access"
}

func (f participantAccessFixture) subject(generation int64, connectionID string) participantaccess.Subject {
	return participantaccess.Subject{
		TenantID: f.tenantID, RoomID: f.roomID, SessionID: f.sessionID, ParticipantSessionID: f.participantID,
		ParticipantGeneration: generation, Provider: participantaccess.ProviderCloudflareSFU, CloudflareConnectionID: connectionID,
	}
}

func (f participantAccessFixture) rooms() mediaRoomService {
	return mediaRoomService{room: rooms.Room{ID: f.roomID, TenantID: f.tenantID, MediaPlane: "cf_sfu"}}
}

func (f participantAccessFixture) tenants() tenantService {
	return tenantService{getTenant: func(context.Context, utilities.ID) (tenants.Tenant, error) {
		return tenants.Tenant{ID: f.tenantID, MediaPlaneProviderConfig: []byte(`{"api_key":"provider-api-key-secret","private_key":"provider-private-key-secret"}`)}, nil
	}}
}

func (f participantAccessFixture) resolver() mediaPlaneResolverFunc {
	return mediaPlaneResolverFunc(func(context.Context, tenants.Tenant, rooms.Room) (*mediaplane.Service, error) {
		service := mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareSFU, f.plane)
		return &service, nil
	})
}

func (f participantAccessFixture) resolverWithEvent(events *[]string) mediaPlaneResolverFunc {
	return mediaPlaneResolverFunc(func(context.Context, tenants.Tenant, rooms.Room) (*mediaplane.Service, error) {
		*events = append(*events, "resolver")
		service := mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareSFU, createEventPlane{participantAccessPlane: f.plane, events: events})
		return &service, nil
	})
}

type createEventPlane struct {
	*participantAccessPlane
	events *[]string
}

func (p createEventPlane) CreateJoin(ctx context.Context, input mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	*p.events = append(*p.events, "create")
	return p.participantAccessPlane.CreateJoin(ctx, input)
}

func (f participantAccessFixture) refresh(t *testing.T, body string, overrides httpapi.Options) *httptest.ResponseRecorder {
	t.Helper()
	if overrides.Rooms == nil {
		overrides.Rooms = f.rooms()
	}
	if overrides.Tenants == nil {
		overrides.Tenants = f.tenants()
	}
	if overrides.MediaPlane == nil {
		overrides.MediaPlane = f.resolver()
	}
	if overrides.SyncTokenRefresh == nil {
		overrides.SyncTokenRefresh = syncTokenRefreshIssuerFunc(func(context.Context, synctokens.SubjectKey) (synctokens.Token, error) {
			return synctokens.Token{Value: "sync-refreshed-token", ExpiresAt: time.Date(2026, 7, 21, 12, 5, 0, 0, time.UTC)}, nil
		})
	}
	if overrides.ParticipantMediaIssuer == nil {
		overrides.ParticipantMediaIssuer = participantMediaIssuerFunc(func(context.Context, participantaccess.Subject) (participantaccess.MediaCredential, error) {
			return participantaccess.MediaCredential{Token: "media-refreshed-token", ExpiresAt: time.Date(2026, 7, 21, 12, 5, 0, 0, time.UTC)}, nil
		})
	}
	if overrides.ParticipantMediaVerify == nil {
		overrides.ParticipantMediaVerify = participantMediaVerifierFunc(func(context.Context, string) (participantaccess.Subject, error) {
			return f.subject(7, "connection-current"), nil
		})
	}
	if overrides.ParticipantMediaActive == nil {
		overrides.ParticipantMediaActive = activeParticipantAuthorizerFunc(func(context.Context, participantaccess.Subject) (bool, error) { return true, nil })
	}
	if overrides.ParticipantGeneration == nil {
		overrides.ParticipantGeneration = participantGenerationAuthorizerFunc(func(context.Context, synctokens.SubjectKey, int64) (bool, error) { return true, nil })
	}
	request := bearerRequestWithBody(http.MethodPost, f.accessPath(), "raw-session-token", body)
	return requestWithOptionsAndRequest(t, request, authenticatedOptions(t, overrides))
}

func assertParticipantAccessSubject(t *testing.T, response *participantAccessHTTPResponse, fixture participantAccessFixture, generation int64) {
	t.Helper()
	if response.Subject.TenantID != fixture.tenantID.String() || response.Subject.RoomID != fixture.roomID.String() || response.Subject.SessionID != fixture.sessionID.String() || response.Subject.ParticipantSessionID != fixture.participantID.String() || response.Subject.ParticipantGeneration != generation {
		t.Fatalf("participant access subject = %#v", response.Subject)
	}
}
