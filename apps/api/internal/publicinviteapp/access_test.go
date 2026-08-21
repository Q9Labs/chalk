package publicinviteapp

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestAccessGrantGuestUsesRTKPayloadAndStableRequest(t *testing.T) {
	fixture := newAccessFixture(t, mediaplane.ProviderCloudflareRTK)
	arrival := fixture.arrival(publicinvites.IdentityGuest)

	grant, err := fixture.access.GrantPublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: arrival})
	if err != nil {
		t.Fatal(err)
	}
	if grant.Provider != publicinvites.PublicProviderCloudflareRTK || grant.ProviderSubject != "rtk-participant" || grant.ClientPayload.Token != "rtk-token" || grant.ClientPayload.ProviderSubject != "rtk-participant" {
		t.Fatalf("grant = %#v", grant)
	}
	if fixture.episodes.joinInput.IdentityMode != string(publicinvites.IdentityGuest) || !fixture.episodes.joinInput.AccountID.IsZero() || fixture.episodes.joinInput.Role != publicinvites.PublicRoleCollaborator || fixture.episodes.joinInput.Request.Key != arrival.IdempotencyKey {
		t.Fatalf("join input = %#v", fixture.episodes.joinInput)
	}
	if fixture.media.createInput.ExternalParticipantID != fixture.participantID.String() {
		t.Fatalf("external participant id = %q", fixture.media.createInput.ExternalParticipantID)
	}
}

func TestAccessGrantAuthorizedAccountUsesSFUPayload(t *testing.T) {
	fixture := newAccessFixture(t, mediaplane.ProviderCloudflareSFU)
	arrival := fixture.arrival(publicinvites.IdentityAccount)
	arrival.AccountID = fixture.accountID

	grant, err := fixture.access.GrantPublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: arrival})
	if err != nil {
		t.Fatal(err)
	}
	if grant.Provider != publicinvites.PublicProviderCloudflareSFU || grant.ProviderSubject != "sfu-connection" || grant.ClientPayload.ConnectionID != "sfu-connection" || grant.ClientPayload.StunServer != "stun.example.test" {
		t.Fatalf("grant = %#v", grant)
	}
	if fixture.episodes.joinInput.IdentityMode != string(publicinvites.IdentityAccount) || fixture.episodes.joinInput.AccountID != fixture.accountID {
		t.Fatalf("account join input = %#v", fixture.episodes.joinInput)
	}
	if fixture.mediaToken.subject.CloudflareConnectionID != "sfu-connection" || fixture.mediaToken.subject.ProviderSubject != "" {
		t.Fatalf("SFU media subject = %#v", fixture.mediaToken.subject)
	}
	if fixture.media.createInput.ParticipantName != arrival.DisplayName {
		t.Fatalf("participant name = %q, want %q", fixture.media.createInput.ParticipantName, arrival.DisplayName)
	}
}

func TestAccessGrantReplayKeepsJoinRequestIdentity(t *testing.T) {
	fixture := newAccessFixture(t, mediaplane.ProviderCloudflareRTK)
	arrival := fixture.arrival(publicinvites.IdentityGuest)
	if _, err := fixture.access.GrantPublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: arrival}); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.access.GrantPublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: arrival}); err != nil {
		t.Fatal(err)
	}
	if len(fixture.episodes.joinInputs) != 2 || fixture.episodes.joinInputs[0].Request.Key != fixture.episodes.joinInputs[1].Request.Key || fixture.episodes.joinInputs[0].Request.Fingerprint != fixture.episodes.joinInputs[1].Request.Fingerprint {
		t.Fatalf("replay requests = %#v", fixture.episodes.joinInputs)
	}
}

func TestAccessGrantRejectsMissingRoleBeforeMedia(t *testing.T) {
	fixture := newAccessFixture(t, mediaplane.ProviderCloudflareRTK)
	fixture.episodes.joinErr = episodes.ErrInvalidRole
	_, err := fixture.access.GrantPublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: fixture.arrival(publicinvites.IdentityGuest)})
	if !errors.Is(err, episodes.ErrInvalidRole) {
		t.Fatalf("error = %v, want invalid role", err)
	}
	if fixture.media.createCalls != 0 {
		t.Fatalf("media create calls = %d", fixture.media.createCalls)
	}
}

func TestAccessGrantArchivedEpisodeFailureDoesNotIssueCredentials(t *testing.T) {
	fixture := newAccessFixture(t, mediaplane.ProviderCloudflareRTK)
	fixture.episodes.joinErr = publicinvites.ErrInviteUnavailable
	_, err := fixture.access.GrantPublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: fixture.arrival(publicinvites.IdentityGuest)})
	if !errors.Is(err, publicinvites.ErrInviteUnavailable) {
		t.Fatalf("error = %v, want unavailable", err)
	}
	if fixture.sync.calls != 0 || fixture.mediaToken.calls != 0 {
		t.Fatalf("credentials issued: sync=%d media=%d", fixture.sync.calls, fixture.mediaToken.calls)
	}
}

func TestAccessRefreshRejectsChangedProviderSubject(t *testing.T) {
	fixture := newAccessFixture(t, mediaplane.ProviderCloudflareSFU)
	arrival := fixture.arrival(publicinvites.IdentityGuest)
	arrival.Provider = publicinvites.PublicProviderCloudflareSFU
	arrival.ProviderSubject = "old-connection"
	fixture.media.resumeJoin = mediaplane.Join{Provider: mediaplane.ProviderCloudflareSFU, ClientPayload: map[string]any{"connectionId": "new-connection", "stunServer": "stun.example.test"}}

	_, err := fixture.access.RefreshPublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: arrival})
	if !errors.Is(err, ErrAccessUnavailable) {
		t.Fatalf("error = %v, want access unavailable", err)
	}
	if fixture.sync.calls != 0 || fixture.mediaToken.calls != 0 {
		t.Fatalf("credentials issued: sync=%d media=%d", fixture.sync.calls, fixture.mediaToken.calls)
	}
}

func TestAccessLeavePersistsLifecycleBeforeBestEffortProviderRemoval(t *testing.T) {
	fixture := newAccessFixture(t, mediaplane.ProviderCloudflareRTK)
	arrival := fixture.arrival(publicinvites.IdentityGuest)
	arrival.Provider = publicinvites.PublicProviderCloudflareRTK
	arrival.ProviderSubject = "rtk-participant"
	fixture.media.removeErr = errors.New("provider unavailable")

	if err := fixture.access.RevokePublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: arrival}); err != nil {
		t.Fatal(err)
	}
	if fixture.episodes.leaveCalls != 1 || fixture.media.removeCalls != 1 {
		t.Fatalf("leave calls = %d, provider remove calls = %d", fixture.episodes.leaveCalls, fixture.media.removeCalls)
	}
}

type accessFixture struct {
	access        publicinvites.Access
	episodes      *joinServiceStub
	media         *mediaPlaneStub
	sync          *syncIssuerStub
	mediaToken    *mediaIssuerStub
	accountID     utilities.ID
	arrivalID     utilities.ID
	episodeID     utilities.ID
	participantID utilities.ID
	tenantID      utilities.ID
	spaceID       utilities.ID
}

func newAccessFixture(t *testing.T, provider mediaplane.Provider) accessFixture {
	t.Helper()
	tenantID := testID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := testID(t, "22222222-2222-4222-8222-222222222222")
	episodeID := testID(t, "33333333-3333-4333-8333-333333333333")
	participantID := testID(t, "44444444-4444-4444-8444-444444444444")
	arrivalID := testID(t, "55555555-5555-4555-8555-555555555555")
	accountID := testID(t, "66666666-6666-4666-8666-666666666666")

	media := &mediaPlaneStub{episode: mediaplane.Episode{Provider: provider, Ref: "provider-episode"}}
	if provider == mediaplane.ProviderCloudflareRTK {
		media.createJoin = mediaplane.Join{Provider: provider, ParticipantRef: "rtk-participant", ClientPayload: map[string]any{"token": "rtk-token"}}
	} else {
		media.createJoin = mediaplane.Join{Provider: provider, ClientPayload: map[string]any{"connectionId": "sfu-connection", "stunServer": "stun.example.test"}}
	}
	participant := episodes.Participant{ID: participantID, TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, AccountID: accountID, Generation: 2, Role: publicinvites.PublicRoleCollaborator, Status: "active"}
	episode := episodes.Episode{ID: episodeID, TenantID: tenantID, SpaceID: spaceID, Status: "live"}
	episodesStub := &joinServiceStub{result: episodes.PublicJoinResult{Episode: episode, Participant: participant}}
	mediaService := mediaplane.NewServiceForProvider(provider, media)
	resolver := &mediaResolverStub{service: &mediaService}
	sync := &syncIssuerStub{token: synctokens.Token{Value: "sync-token", ExpiresAt: time.Now().Add(time.Minute)}}
	mediaToken := &mediaIssuerStub{credential: accessgrants.MediaCredential{Token: "media-token", ExpiresAt: time.Now().Add(2 * time.Minute)}}
	access, err := NewAccessPort(AccessConfig{
		Episodes: episodesStub, Spaces: &spaceLookupStub{space: spaces.Space{ID: spaceID, TenantID: tenantID, Slug: "demo"}},
		Tenants: &tenantLookupStub{tenant: tenants.Tenant{ID: tenantID}}, MediaResolver: resolver,
		SyncTokens: sync, MediaTokens: mediaToken,
	})
	if err != nil {
		t.Fatal(err)
	}
	return accessFixture{access: access, episodes: episodesStub, media: media, sync: sync, mediaToken: mediaToken, accountID: accountID, arrivalID: arrivalID, episodeID: episodeID, participantID: participantID, tenantID: tenantID, spaceID: spaceID}
}

func (f accessFixture) arrival(identity publicinvites.IdentityMode) publicinvites.Arrival {
	accountID := utilities.ID{}
	if identity == publicinvites.IdentityAccount {
		accountID = f.accountID
	}
	return publicinvites.Arrival{ArrivalHandle: f.arrivalID, TenantID: f.tenantID, SpaceID: f.spaceID, IdentityMode: identity, AccountID: accountID, DisplayName: "Visitor", IdempotencyKey: "arrival-request-0001", EpisodeID: f.episodeID, ParticipantID: f.participantID, ParticipantGeneration: 2}
}

type joinServiceStub struct {
	result      episodes.PublicJoinResult
	joinErr     error
	findErr     error
	leaveErr    error
	joinInput   episodes.PublicJoinInput
	joinInputs  []episodes.PublicJoinInput
	leaveCalls  int
	readyResult episodes.PublicJoinResult
}

func (s *joinServiceStub) JoinPublic(_ context.Context, input episodes.PublicJoinInput) (episodes.PublicJoinResult, error) {
	s.joinInput = input
	s.joinInputs = append(s.joinInputs, input)
	if s.joinErr != nil {
		return episodes.PublicJoinResult{}, s.joinErr
	}
	return s.result, nil
}

func (s *joinServiceStub) FindPublic(context.Context, episodes.PublicAccessInput) (episodes.PublicJoinResult, error) {
	if s.findErr != nil {
		return episodes.PublicJoinResult{}, s.findErr
	}
	return s.result, nil
}

func (s *joinServiceStub) LeavePublic(context.Context, episodes.PublicLeaveInput) (episodes.PublicLeaveResult, error) {
	s.leaveCalls++
	if s.leaveErr != nil {
		return episodes.PublicLeaveResult{}, s.leaveErr
	}
	return episodes.PublicLeaveResult{Episode: s.result.Episode, Participant: s.result.Participant}, nil
}

func (s *joinServiceStub) WaitPublicParticipantReady(context.Context, episodes.PublicParticipantKey) (episodes.PublicJoinResult, error) {
	if s.readyResult.Episode.ID.IsZero() {
		return s.result, nil
	}
	return s.readyResult, nil
}

type spaceLookupStub struct{ space spaces.Space }

func (s *spaceLookupStub) GetSpace(context.Context, utilities.ID, utilities.ID) (spaces.Space, error) {
	return s.space, nil
}

type tenantLookupStub struct{ tenant tenants.Tenant }

func (s *tenantLookupStub) GetTenant(context.Context, utilities.ID) (tenants.Tenant, error) {
	return s.tenant, nil
}

type mediaResolverStub struct{ service *mediaplane.Service }

func (s *mediaResolverStub) Resolve(context.Context, tenants.Tenant, spaces.Space) (*mediaplane.Service, error) {
	return s.service, nil
}

type mediaPlaneStub struct {
	episode     mediaplane.Episode
	createJoin  mediaplane.Join
	resumeJoin  mediaplane.Join
	createInput mediaplane.CreateJoinInput
	resumeInput mediaplane.ResumeJoinInput
	createCalls int
	removeCalls int
	removeErr   error
}

func (s *mediaPlaneStub) EnsureEpisode(context.Context, mediaplane.EnsureEpisodeInput) (mediaplane.Episode, error) {
	return s.episode, nil
}

func (s *mediaPlaneStub) CreateJoin(_ context.Context, input mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	s.createCalls++
	s.createInput = input
	return s.createJoin, nil
}

func (s *mediaPlaneStub) ResumeJoin(_ context.Context, input mediaplane.ResumeJoinInput) (mediaplane.Join, error) {
	s.resumeInput = input
	return s.resumeJoin, nil
}

func (s *mediaPlaneStub) RemoveParticipant(context.Context, mediaplane.RemoveParticipantInput) error {
	s.removeCalls++
	return s.removeErr
}

func (s *mediaPlaneStub) EndEpisode(context.Context, mediaplane.EndEpisodeInput) error { return nil }

func (s *mediaPlaneStub) EpisodeUsage(context.Context, mediaplane.EpisodeUsageInput) (mediaplane.Usage, error) {
	return mediaplane.Usage{}, nil
}

type syncIssuerStub struct {
	token synctokens.Token
	calls int
}

func (s *syncIssuerStub) IssueForParticipant(context.Context, synctokens.SubjectKey) (synctokens.Token, error) {
	s.calls++
	return s.token, nil
}

type mediaIssuerStub struct {
	credential accessgrants.MediaCredential
	calls      int
	subject    accessgrants.Subject
}

func (s *mediaIssuerStub) Issue(_ context.Context, subject accessgrants.Subject) (accessgrants.MediaCredential, error) {
	s.calls++
	s.subject = subject
	return s.credential, nil
}

func testID(t *testing.T, raw string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(raw)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
