package httpapi_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type accessGrantPlane struct {
	ensureCalls int
	createCalls int
	resumeCalls int
	createInput mediaplane.CreateJoinInput
	resumeInput mediaplane.ResumeJoinInput
	createJoin  mediaplane.Join
	resumeJoin  mediaplane.Join
}

type participantMediaIssuerFunc func(context.Context, accessgrants.Subject) (accessgrants.MediaCredential, error)

type participantGenerationAuthorizerFunc func(context.Context, synctokens.SubjectKey, int64) (bool, error)

type syncTokenIssuerFunc func(context.Context, synctokens.Input) (synctokens.Token, error)

func (f syncTokenIssuerFunc) Issue(ctx context.Context, input synctokens.Input) (synctokens.Token, error) {
	return f(ctx, input)
}

type syncTokenRefreshIssuerFunc func(context.Context, synctokens.SubjectKey) (synctokens.Token, error)

func (f syncTokenRefreshIssuerFunc) IssueForParticipant(ctx context.Context, key synctokens.SubjectKey) (synctokens.Token, error) {
	return f(ctx, key)
}

type participantMediaVerifierFunc func(context.Context, string) (accessgrants.Subject, error)

func (f participantMediaVerifierFunc) Verify(ctx context.Context, token string) (accessgrants.Subject, error) {
	return f(ctx, token)
}

type activeParticipantAuthorizerFunc func(context.Context, accessgrants.Subject) (bool, error)

func (f activeParticipantAuthorizerFunc) AuthorizeActiveParticipant(ctx context.Context, subject accessgrants.Subject) (bool, error) {
	return f(ctx, subject)
}

type mediaPlaneResolverFunc func(context.Context, tenants.Tenant, spaces.Space) (*mediaplane.Service, error)

func (f mediaPlaneResolverFunc) Resolve(ctx context.Context, tenant tenants.Tenant, space spaces.Space) (*mediaplane.Service, error) {
	return f(ctx, tenant, space)
}

type lifecycleService struct {
	admit func(context.Context, episodes.AdmitParticipantInput) (episodes.Admission, error)
}

func (s lifecycleService) CreateEpisode(context.Context, episodes.CreateEpisodeInput) (episodes.Episode, error) {
	return episodes.Episode{}, nil
}

func (s lifecycleService) GetEpisode(context.Context, utilities.ID, utilities.ID, utilities.ID) (episodes.Episode, error) {
	return episodes.Episode{}, nil
}

func (s lifecycleService) ListEpisodes(context.Context, utilities.ID, utilities.ID, pagination.PageRequest) (episodes.EpisodeList, error) {
	return episodes.EpisodeList{}, nil
}

func (s lifecycleService) AdmitParticipant(ctx context.Context, input episodes.AdmitParticipantInput) (episodes.Admission, error) {
	if s.admit == nil {
		return episodes.Admission{}, nil
	}
	return s.admit(ctx, input)
}

func (s lifecycleService) RequestParticipantRemoval(context.Context, episodes.RequestParticipantRemovalInput) (episodes.Removal, error) {
	return episodes.Removal{}, nil
}

func (s lifecycleService) RequestEpisodeEnd(context.Context, episodes.RequestEpisodeEndInput) (episodes.EndRequest, error) {
	return episodes.EndRequest{}, nil
}

func (s lifecycleService) SetDeadline(context.Context, episodes.SetDeadlineInput) (episodes.ControlRequest, error) {
	return episodes.ControlRequest{}, nil
}

type accessGrantHTTPResponse struct {
	Subject struct {
		TenantID              string `json:"tenant_id"`
		SpaceID               string `json:"space_id"`
		EpisodeID             string `json:"episode_id"`
		ParticipantID         string `json:"participant_id"`
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

func (f participantMediaIssuerFunc) Issue(ctx context.Context, subject accessgrants.Subject) (accessgrants.MediaCredential, error) {
	return f(ctx, subject)
}

func (f participantGenerationAuthorizerFunc) AuthorizeActiveParticipantGeneration(ctx context.Context, key synctokens.SubjectKey, generation int64) (bool, error) {
	return f(ctx, key, generation)
}

func (p *accessGrantPlane) EnsureEpisode(_ context.Context, input mediaplane.EnsureEpisodeInput) (mediaplane.Episode, error) {
	p.ensureCalls++
	return mediaplane.Episode{Provider: input.Provider, Ref: "media-episode-ref"}, nil
}

func (p *accessGrantPlane) CreateJoin(_ context.Context, input mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	p.createCalls++
	p.createInput = input
	return p.createJoin, nil
}

func (p *accessGrantPlane) ResumeJoin(_ context.Context, input mediaplane.ResumeJoinInput) (mediaplane.Join, error) {
	p.resumeCalls++
	p.resumeInput = input
	return p.resumeJoin, nil
}

func (*accessGrantPlane) RemoveParticipant(context.Context, mediaplane.RemoveParticipantInput) error {
	return nil
}

func (*accessGrantPlane) EndEpisode(context.Context, mediaplane.EndEpisodeInput) error {
	return nil
}

func (*accessGrantPlane) EpisodeUsage(context.Context, mediaplane.EpisodeUsageInput) (mediaplane.Usage, error) {
	return mediaplane.Usage{}, nil
}

func TestAdmittedParticipantResponseIncludesAccessEnvelope(t *testing.T) {
	fixture := newAccessGrantFixture(t)
	intentID := mustTenantID(t, "55555555-5555-4555-8555-555555555555")
	issuedSubject := accessgrants.Subject{}
	request := bearerRequestWithBody(http.MethodPost, fixture.participantsPath(), "raw-session-token", `{"participant_id":"`+fixture.participantID.String()+`","name":"Ada","role":"participant"}`)
	request.Header.Set("Idempotency-Key", "admit-access-envelope-0001")
	response := requestWithOptionsAndRequest(t, request, authenticatedOptions(t, httpapi.Options{
		Episodes: lifecycleService{admit: func(_ context.Context, input episodes.AdmitParticipantInput) (episodes.Admission, error) {
			return episodes.Admission{
				Participant: episodes.Participant{ID: fixture.participantID, TenantID: fixture.tenantID, SpaceID: fixture.spaceID, EpisodeID: fixture.episodeID, Generation: 7, Status: episodes.ParticipantStatusJoining},
				Intent: episodes.Intent{
					ID: intentID, RequestKey: input.Request.Key, IntentName: episodes.IntentParticipantJoined,
					ParticipantID: fixture.participantID, ParticipantGeneration: 7,
				},
			}, nil
		}},
		SyncTokens: syncTokenIssuerFunc(func(context.Context, synctokens.Input) (synctokens.Token, error) {
			return synctokens.Token{Value: "sync-access-token", ExpiresAt: time.Date(2026, 7, 21, 12, 5, 0, 0, time.UTC)}, nil
		}),
		ParticipantMediaIssuer: participantMediaIssuerFunc(func(_ context.Context, subject accessgrants.Subject) (accessgrants.MediaCredential, error) {
			issuedSubject = subject
			return accessgrants.MediaCredential{Token: "media-access-token", ExpiresAt: time.Date(2026, 7, 21, 12, 5, 0, 0, time.UTC)}, nil
		}),
		Spaces:     fixture.spaceService(),
		Tenants:    fixture.tenants(),
		MediaPlane: fixture.resolver(),
	}))

	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", response.Code, response.Body.String())
	}
	var body struct {
		Access *accessGrantHTTPResponse `json:"access"`
	}
	decodeJSON(t, response, &body)
	if body.Access == nil {
		t.Fatal("admitted response omitted participant access")
	}
	if body.Access.Sync.Token != "sync-access-token" || body.Access.Media.Token != "media-access-token" || body.Access.Sync.Token == body.Access.Media.Token {
		t.Fatalf("access credentials = %#v", body.Access)
	}
	assertAccessGrantSubject(t, body.Access, fixture, 7)
	if body.Access.Media.Provider != accessgrants.ProviderCloudflareSFU || body.Access.Media.ClientPayload["connectionId"] != "connection-new" || body.Access.Media.ClientPayload["sessionId"] != "provider-session" {
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

func TestPendingKnockResponseHasNoAccessGrant(t *testing.T) {
	fixture := newAccessGrantFixture(t)
	requestID := mustTenantID(t, "66666666-6666-4666-8666-666666666666")
	intentID := mustTenantID(t, "55555555-5555-4555-8555-555555555555")
	request := bearerRequestWithBody(http.MethodPost, fixture.participantsPath(), "raw-session-token", `{"participant_id":"`+fixture.participantID.String()+`","name":"Ada","role":"participant"}`)
	request.Header.Set("Idempotency-Key", "pending-access-envelope-0001")
	response := requestWithOptionsAndRequest(t, request, authenticatedOptions(t, httpapi.Options{
		Episodes: lifecycleService{admit: func(context.Context, episodes.AdmitParticipantInput) (episodes.Admission, error) {
			return episodes.Admission{
				Participant:      episodes.Participant{ID: fixture.participantID, TenantID: fixture.tenantID, SpaceID: fixture.spaceID, EpisodeID: fixture.episodeID, Generation: 7},
				Intent:           episodes.Intent{ID: intentID, IntentName: episodes.IntentAdmissionRequested},
				AdmissionRequest: &episodes.AdmissionRequest{ID: requestID, Status: "pending", ExpiresAt: time.Date(2026, 7, 21, 12, 5, 0, 0, time.UTC)},
			}, nil
		}},
		SyncTokens: syncTokenIssuerFunc(func(context.Context, synctokens.Input) (synctokens.Token, error) {
			t.Fatal("pending knock issued sync credentials")
			return synctokens.Token{}, nil
		}),
		ParticipantMediaIssuer: participantMediaIssuerFunc(func(context.Context, accessgrants.Subject) (accessgrants.MediaCredential, error) {
			t.Fatal("pending knock issued media credentials")
			return accessgrants.MediaCredential{}, nil
		}),
		MediaPlane: mediaPlaneResolverFunc(func(context.Context, tenants.Tenant, spaces.Space) (*mediaplane.Service, error) {
			t.Fatal("pending knock contacted media provider")
			return nil, nil
		}),
	}))

	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", response.Code, response.Body.String())
	}
	var body map[string]any
	decodeJSON(t, response, &body)
	if _, exists := body["access"]; exists {
		t.Fatalf("pending knock exposed participant access: %#v", body["access"])
	}
}

func TestAccessGrantRefreshResumesCurrentMediaConnection(t *testing.T) {
	fixture := newAccessGrantFixture(t)
	currentSubject := fixture.subject(7, "connection-current")
	fixture.plane.resumeJoin = mediaplane.Join{
		Provider: mediaplane.ProviderCloudflareSFU, ParticipantRef: fixture.participantID.String(),
		ClientPayload: map[string]any{"connectionId": "connection-current", "sessionId": "provider-session"},
	}
	verifiedToken := ""
	response := fixture.refresh(t, `{"participant_generation":7,"current_media_token":"current-media-token","replace_media_connection":false}`, httpapi.Options{
		ParticipantMediaVerify: participantMediaVerifierFunc(func(_ context.Context, token string) (accessgrants.Subject, error) {
			verifiedToken = token
			return currentSubject, nil
		}),
		ParticipantMediaActive: activeParticipantAuthorizerFunc(func(_ context.Context, subject accessgrants.Subject) (bool, error) {
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
	var body accessGrantHTTPResponse
	decodeJSON(t, response, &body)
	assertAccessGrantSubject(t, &body, fixture, 7)
	if body.Media.ClientPayload["connectionId"] != "connection-current" || body.Sync.Token != "sync-refreshed-token" || body.Media.Token != "media-refreshed-token" {
		t.Fatalf("refreshed access = %#v", body)
	}
	if strings.Contains(response.Body.String(), "current-media-token") {
		t.Fatalf("response repeated current media credential: %s", response.Body.String())
	}
}

func TestAccessGrantReplacementAuthorizesGenerationBeforeCreatingConnection(t *testing.T) {
	fixture := newAccessGrantFixture(t)
	events := []string{}
	fixture.plane.createJoin = mediaplane.Join{
		Provider: mediaplane.ProviderCloudflareSFU, ParticipantRef: fixture.participantID.String(),
		ClientPayload: map[string]any{"connectionId": "connection-replacement", "sessionId": "provider-session"},
	}
	response := fixture.refresh(t, `{"participant_generation":7,"replace_media_connection":true}`, httpapi.Options{
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
	var body accessGrantHTTPResponse
	decodeJSON(t, response, &body)
	if body.Media.ClientPayload["connectionId"] != "connection-replacement" {
		t.Fatalf("replacement bootstrap = %#v", body.Media.ClientPayload)
	}
}

func TestAccessGrantRefreshRejectsBeforeMediaProvider(t *testing.T) {
	fixture := newAccessGrantFixture(t)
	wrongSpaceID := mustTenantID(t, "77777777-7777-4777-8777-777777777777")
	tests := []struct {
		name       string
		body       string
		verify     participantMediaVerifierFunc
		active     activeParticipantAuthorizerFunc
		generation participantGenerationAuthorizerFunc
		wantCode   string
	}{
		{name: "missing current token", body: `{"participant_generation":7}`, wantCode: "request.invalid"},
		{name: "invalid current token", body: `{"participant_generation":7,"current_media_token":"invalid"}`, verify: func(context.Context, string) (accessgrants.Subject, error) {
			return accessgrants.Subject{}, accessgrants.ErrInvalidSignature
		}, wantCode: "request.invalid"},
		{name: "crossed audience", body: `{"participant_generation":7,"current_media_token":"sync-token"}`, verify: func(context.Context, string) (accessgrants.Subject, error) {
			return accessgrants.Subject{}, accessgrants.ErrInvalidAudience
		}, wantCode: "request.invalid"},
		{name: "stale generation", body: `{"participant_generation":7,"current_media_token":"stale"}`, verify: func(context.Context, string) (accessgrants.Subject, error) {
			return fixture.subject(6, "connection-current"), nil
		}, wantCode: "access.forbidden"},
		{name: "crossed route", body: `{"participant_generation":7,"current_media_token":"crossed-route"}`, verify: func(context.Context, string) (accessgrants.Subject, error) {
			subject := fixture.subject(7, "connection-current")
			subject.SpaceID = wrongSpaceID
			return subject, nil
		}, wantCode: "access.forbidden"},
		{name: "removed participant", body: `{"participant_generation":7,"current_media_token":"removed"}`, verify: func(context.Context, string) (accessgrants.Subject, error) {
			return fixture.subject(7, "connection-current"), nil
		}, active: func(context.Context, accessgrants.Subject) (bool, error) { return false, nil }, wantCode: "access.forbidden"},
		{name: "stale replacement generation", body: `{"participant_generation":7,"replace_media_connection":true}`, generation: func(context.Context, synctokens.SubjectKey, int64) (bool, error) {
			return false, nil
		}, wantCode: "access.forbidden"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			plane := &accessGrantPlane{}
			options := httpapi.Options{
				ParticipantMediaVerify: test.verify,
				ParticipantMediaActive: test.active,
				ParticipantGeneration:  test.generation,
				MediaPlane: mediaPlaneResolverFunc(func(context.Context, tenants.Tenant, spaces.Space) (*mediaplane.Service, error) {
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

type accessGrantFixture struct {
	tenantID      utilities.ID
	spaceID       utilities.ID
	episodeID     utilities.ID
	participantID utilities.ID
	plane         *accessGrantPlane
}

func newAccessGrantFixture(t *testing.T) accessGrantFixture {
	t.Helper()
	return accessGrantFixture{
		tenantID:      mustTenantID(t, "11111111-1111-4111-8111-111111111111"),
		spaceID:       mustTenantID(t, "22222222-2222-4222-8222-222222222222"),
		episodeID:     mustTenantID(t, "33333333-3333-4333-8333-333333333333"),
		participantID: mustTenantID(t, "44444444-4444-4444-8444-444444444444"),
		plane: &accessGrantPlane{createJoin: mediaplane.Join{
			Provider: mediaplane.ProviderCloudflareSFU, ParticipantRef: "provider-participant",
			ClientPayload: map[string]any{"connectionId": "connection-new", "sessionId": "provider-session"},
		}},
	}
}

func (f accessGrantFixture) participantsPath() string {
	return "/v1/tenants/" + f.tenantID.String() + "/spaces/" + f.spaceID.String() + "/episodes/" + f.episodeID.String() + "/participants"
}

func (f accessGrantFixture) accessPath() string {
	return f.participantsPath() + "/" + f.participantID.String() + "/access-grant"
}

func (f accessGrantFixture) subject(generation int64, connectionID string) accessgrants.Subject {
	return accessgrants.Subject{
		TenantID: f.tenantID, SpaceID: f.spaceID, EpisodeID: f.episodeID, ParticipantID: f.participantID,
		ParticipantGeneration: generation, Provider: accessgrants.ProviderCloudflareSFU, CloudflareConnectionID: connectionID,
	}
}

type accessGrantSpaceService struct {
	space spaces.Space
}

func (s accessGrantSpaceService) CreateSpace(context.Context, spaces.CreateSpaceInput) (spaces.Space, error) {
	return s.space, nil
}

func (s accessGrantSpaceService) GetSpace(context.Context, utilities.ID, utilities.ID) (spaces.Space, error) {
	return s.space, nil
}

func (s accessGrantSpaceService) ListSpaces(context.Context, utilities.ID, pagination.PageRequest) (spaces.SpaceList, error) {
	return spaces.SpaceList{Spaces: []spaces.Space{s.space}}, nil
}

func (s accessGrantSpaceService) UpdateSpace(context.Context, utilities.ID, utilities.ID, spaces.UpdateSpaceInput) (spaces.Space, error) {
	return s.space, nil
}

func (f accessGrantFixture) spaceService() accessGrantSpaceService {
	return accessGrantSpaceService{space: spaces.Space{ID: f.spaceID, TenantID: f.tenantID, MediaPlane: "cf_sfu"}}
}

func (f accessGrantFixture) tenants() tenantService {
	return tenantService{getTenant: func(context.Context, utilities.ID) (tenants.Tenant, error) {
		return tenants.Tenant{ID: f.tenantID, MediaPlaneProviderConfig: []byte(`{"api_key":"provider-api-key-secret","private_key":"provider-private-key-secret"}`)}, nil
	}}
}

func (f accessGrantFixture) resolver() mediaPlaneResolverFunc {
	return mediaPlaneResolverFunc(func(context.Context, tenants.Tenant, spaces.Space) (*mediaplane.Service, error) {
		service := mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareSFU, f.plane)
		return &service, nil
	})
}

func (f accessGrantFixture) resolverWithEvent(events *[]string) mediaPlaneResolverFunc {
	return mediaPlaneResolverFunc(func(context.Context, tenants.Tenant, spaces.Space) (*mediaplane.Service, error) {
		*events = append(*events, "resolver")
		service := mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareSFU, createEventPlane{accessGrantPlane: f.plane, events: events})
		return &service, nil
	})
}

type createEventPlane struct {
	*accessGrantPlane
	events *[]string
}

func (p createEventPlane) CreateJoin(ctx context.Context, input mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	*p.events = append(*p.events, "create")
	return p.accessGrantPlane.CreateJoin(ctx, input)
}

func (f accessGrantFixture) refresh(t *testing.T, body string, overrides httpapi.Options) *httptest.ResponseRecorder {
	t.Helper()
	if overrides.Spaces == nil {
		overrides.Spaces = f.spaceService()
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
		overrides.ParticipantMediaIssuer = participantMediaIssuerFunc(func(context.Context, accessgrants.Subject) (accessgrants.MediaCredential, error) {
			return accessgrants.MediaCredential{Token: "media-refreshed-token", ExpiresAt: time.Date(2026, 7, 21, 12, 5, 0, 0, time.UTC)}, nil
		})
	}
	if overrides.ParticipantMediaVerify == nil {
		overrides.ParticipantMediaVerify = participantMediaVerifierFunc(func(context.Context, string) (accessgrants.Subject, error) {
			return f.subject(7, "connection-current"), nil
		})
	}
	if overrides.ParticipantMediaActive == nil {
		overrides.ParticipantMediaActive = activeParticipantAuthorizerFunc(func(context.Context, accessgrants.Subject) (bool, error) { return true, nil })
	}
	if overrides.ParticipantGeneration == nil {
		overrides.ParticipantGeneration = participantGenerationAuthorizerFunc(func(context.Context, synctokens.SubjectKey, int64) (bool, error) { return true, nil })
	}
	request := bearerRequestWithBody(http.MethodPost, f.accessPath(), "raw-session-token", body)
	return requestWithOptionsAndRequest(t, request, authenticatedOptions(t, overrides))
}

func assertAccessGrantSubject(t *testing.T, response *accessGrantHTTPResponse, fixture accessGrantFixture, generation int64) {
	t.Helper()
	if response.Subject.TenantID != fixture.tenantID.String() || response.Subject.SpaceID != fixture.spaceID.String() || response.Subject.EpisodeID != fixture.episodeID.String() || response.Subject.ParticipantID != fixture.participantID.String() || response.Subject.ParticipantGeneration != generation {
		t.Fatalf("participant access subject = %#v", response.Subject)
	}
}
