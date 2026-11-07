package publicinviteapp_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/publicinviteapp"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestApprovedArrivalCollectsGrantWithoutMediaProof(t *testing.T) {
	fixture := newAccessFixture(t)
	access, err := publicinviteapp.NewAccessPort(fixture.config())
	if err != nil {
		t.Fatal(err)
	}
	grant, err := access.GrantPublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: fixture.arrival})
	if err != nil {
		t.Fatal(err)
	}
	if grant.ParticipantID != fixture.arrival.ParticipantID || grant.ParticipantGeneration != fixture.arrival.ParticipantGeneration || grant.ProviderSubject != fixture.arrival.ProviderSubject {
		t.Fatalf("grant changed the admitted Participant or media connection")
	}
	if fixture.plane.createCalls != 0 || fixture.plane.resumeCalls != 1 {
		t.Fatalf("create/resume calls = %d/%d, want 0/1", fixture.plane.createCalls, fixture.plane.resumeCalls)
	}
	if servers := grant.ClientPayload.ICEServers; len(servers) != 2 || servers[1].Username != "user" || servers[1].URLs[0] != "turns:turn.test:443?transport=tcp" {
		t.Fatalf("a guest of an account's Space must keep the TURN ice servers: %+v", servers)
	}
}

func TestAnonymousPublicSpaceGuestGetsNoTurnCredentials(t *testing.T) {
	fixture := newAccessFixture(t)
	fixture.managedTenant = fixture.tenant
	access, err := publicinviteapp.NewAccessPort(fixture.config())
	if err != nil {
		t.Fatal(err)
	}

	grant, err := access.GrantPublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: fixture.arrival})
	if err != nil {
		t.Fatal(err)
	}
	if servers := grant.ClientPayload.ICEServers; len(servers) != 1 || servers[0].Username != "" || servers[0].Credential != "" {
		t.Fatalf("a guest of an anonymous public Space must get STUN only: %+v", servers)
	}
}

func TestAccessPortRequiresTheManagedTenant(t *testing.T) {
	fixture := newAccessFixture(t)
	config := fixture.config()
	config.ManagedTenantID = utilities.ID{}
	if _, err := publicinviteapp.NewAccessPort(config); !errors.Is(err, publicinviteapp.ErrInvalidAccess) {
		t.Fatalf("a missing managed Tenant would hand TURN to everyone, got %v", err)
	}
}

func TestApprovedArrivalRejectsChangedParticipantGeneration(t *testing.T) {
	fixture := newAccessFixture(t)
	fixture.result.Participant.Generation++
	access, err := publicinviteapp.NewAccessPort(fixture.config())
	if err != nil {
		t.Fatal(err)
	}
	_, err = access.GrantPublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: fixture.arrival})
	if !errors.Is(err, publicinvites.ErrMediaProofRejected) {
		t.Fatalf("changed generation error = %v, want %v", err, publicinvites.ErrMediaProofRejected)
	}
	if fixture.plane.createCalls != 0 || fixture.plane.resumeCalls != 0 {
		t.Fatal("stale arrival must not reach the media provider")
	}
}

func TestRefreshReplacementRejectsMissingOrStaleProof(t *testing.T) {
	fixture := newAccessFixture(t)
	access, err := publicinviteapp.NewAccessPort(fixture.config())
	if err != nil {
		t.Fatal(err)
	}
	_, err = access.RefreshPublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: fixture.arrival, ReplaceMediaConnection: true})
	if !errors.Is(err, publicinvites.ErrMediaProofRejected) {
		t.Fatalf("missing proof error = %v, want %v", err, publicinvites.ErrMediaProofRejected)
	}
	_, err = access.RefreshPublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: fixture.arrival})
	if !errors.Is(err, publicinvites.ErrMediaProofRejected) {
		t.Fatalf("missing normal refresh proof error = %v, want %v", err, publicinvites.ErrMediaProofRejected)
	}

	fixture.recovery.subject.ConnectionID = "stale-provider"
	_, err = access.RefreshPublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: fixture.arrival, MediaProof: "stale-proof", ReplaceMediaConnection: true})
	if !errors.Is(err, publicinvites.ErrMediaProofRejected) {
		t.Fatalf("stale proof error = %v, want %v", err, publicinvites.ErrMediaProofRejected)
	}
}

func TestDiscardPublicAccessRemovesOnlyTheReplacementBinding(t *testing.T) {
	fixture := newAccessFixture(t)
	access, err := publicinviteapp.NewAccessPort(fixture.config())
	if err != nil {
		t.Fatal(err)
	}
	grant, err := access.RefreshPublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: fixture.arrival, MediaProof: "expired-proof", ReplaceMediaConnection: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := access.DiscardPublicAccess(context.Background(), grant); err != nil {
		t.Fatal(err)
	}
	if fixture.plane.removeCalls != 1 || fixture.plane.removedParticipantRef != grant.ProviderSubject {
		t.Fatalf("discard calls = %d, participant = %q; want one removal of %q", fixture.plane.removeCalls, fixture.plane.removedParticipantRef, grant.ProviderSubject)
	}
}

type accessFixture struct {
	tenant      utilities.ID
	space       utilities.ID
	episode     utilities.ID
	participant utilities.ID
	arrival     publicinvites.Arrival
	result      episodes.PublicJoinResult
	plane       *mediaPlaneStub
	recovery    *proofVerifierStub
	// managedTenant owns the anonymous public Spaces; it differs from tenant
	// unless a test says the arrival is an anonymous public Space guest.
	managedTenant utilities.ID
	// provider is the Episode's bound media provider; it defaults to Cloudflare.
	provider mediaplane.Provider
	issued   *mediaIssuerStub
	joins    *publicJoinStub
}

// newChalkFixture is an admitted arrival on an Episode bound to the own SFU.
func newChalkFixture(t *testing.T) *accessFixture {
	t.Helper()
	fixture := newAccessFixture(t)
	fixture.provider = mediaplane.ProviderChalkSFU
	fixture.arrival.Provider = publicinvites.PublicProviderChalkSFU
	fixture.recovery.subject.Provider = accessgrants.ProviderChalkSFU
	return fixture
}

func newAccessFixture(t *testing.T) *accessFixture {
	t.Helper()
	tenant := mustID(t, "11111111-1111-4111-8111-111111111111")
	space := mustID(t, "22222222-2222-4222-8222-222222222222")
	episode := mustID(t, "33333333-3333-4333-8333-333333333333")
	participant := mustID(t, "44444444-4444-4444-8444-444444444444")
	proofSubject := accessgrants.Subject{TenantID: tenant, SpaceID: space, EpisodeID: episode, ParticipantID: participant, ParticipantGeneration: 7, Provider: accessgrants.ProviderCloudflareSFU, ConnectionID: "old-provider"}
	result := episodes.PublicJoinResult{Episode: episodes.Episode{ID: episode, TenantID: tenant, SpaceID: space}, Participant: episodes.Participant{ID: participant, TenantID: tenant, SpaceID: space, EpisodeID: episode, Generation: 7}}
	return &accessFixture{
		tenant: tenant, space: space, episode: episode, participant: participant,
		arrival: publicinvites.Arrival{TenantID: tenant, SpaceID: space, EpisodeID: episode, ParticipantID: participant, ParticipantGeneration: 7, Provider: publicinvites.PublicProviderCloudflareSFU, ProviderSubject: "old-provider", IdentityMode: publicinvites.IdentityGuest, DisplayName: "Trace Guest", State: publicinvites.ArrivalAdmitted},
		result:  result, plane: &mediaPlaneStub{}, recovery: &proofVerifierStub{subject: proofSubject},
		managedTenant: mustID(t, "55555555-5555-4555-8555-555555555555"),
		provider:      mediaplane.ProviderCloudflareSFU,
		issued:        &mediaIssuerStub{},
		joins:         &publicJoinStub{result: result},
	}
}

func (f *accessFixture) config() publicinviteapp.AccessConfig {
	f.plane.provider = f.provider
	f.joins.result = f.result
	service := mediaplane.NewServiceForProvider(f.provider, f.plane)
	return publicinviteapp.AccessConfig{
		ManagedTenantID: f.managedTenant,
		Episodes:        f.joins, Spaces: publicSpaceStub{tenantID: f.tenant, spaceID: f.space}, Tenants: publicTenantStub{id: f.tenant},
		MediaResolver: mediaResolverStub{service: &service},
		SyncTokens:    syncIssuerStub{}, MediaTokens: f.issued, MediaProofRecovery: f.recovery,
	}
}

type publicJoinStub struct {
	result     episodes.PublicJoinResult
	joinClient mediaplane.ClientProviders
}

func (s *publicJoinStub) JoinPublic(_ context.Context, input episodes.PublicJoinInput) (episodes.PublicJoinResult, error) {
	s.joinClient = input.MediaClients
	return s.result, nil
}
func (s *publicJoinStub) FindPublic(context.Context, episodes.PublicAccessInput) (episodes.PublicJoinResult, error) {
	return s.result, nil
}
func (s *publicJoinStub) LeavePublic(context.Context, episodes.PublicLeaveInput) (episodes.PublicLeaveResult, error) {
	return episodes.PublicLeaveResult{}, nil
}
func (s *publicJoinStub) WaitPublicParticipantReady(context.Context, episodes.PublicParticipantKey) (episodes.PublicJoinResult, error) {
	return s.result, nil
}

type publicSpaceStub struct{ tenantID, spaceID utilities.ID }

func (s publicSpaceStub) GetSpace(context.Context, utilities.ID, utilities.ID) (spaces.Space, error) {
	return spaces.Space{ID: s.spaceID, TenantID: s.tenantID}, nil
}

type publicTenantStub struct{ id utilities.ID }

func (s publicTenantStub) GetTenant(context.Context, utilities.ID) (tenants.Tenant, error) {
	return tenants.Tenant{ID: s.id}, nil
}

type mediaResolverStub struct{ service *mediaplane.Service }

func (s mediaResolverStub) ResolveEpisode(context.Context, tenants.Tenant, spaces.Space, utilities.ID) (*mediaplane.Service, error) {
	return s.service, nil
}

type syncIssuerStub struct{}

func (syncIssuerStub) IssueForParticipant(context.Context, synctokens.SubjectKey) (synctokens.Token, error) {
	return synctokens.Token{Value: "sync-token", ExpiresAt: time.Now().Add(time.Minute)}, nil
}

type mediaIssuerStub struct{ subject accessgrants.Subject }

func (s *mediaIssuerStub) Issue(_ context.Context, subject accessgrants.Subject) (accessgrants.MediaCredential, error) {
	s.subject = subject
	return accessgrants.MediaCredential{Token: "media-token", ExpiresAt: time.Now().Add(time.Minute)}, nil
}

type proofVerifierStub struct{ subject accessgrants.Subject }

func (s *proofVerifierStub) Verify(context.Context, string) (accessgrants.Subject, error) {
	return s.subject, nil
}
func (s *proofVerifierStub) VerifyForRecovery(context.Context, string) (accessgrants.Subject, error) {
	return s.subject, nil
}

type mediaPlaneStub struct {
	provider              mediaplane.Provider
	resumeCalls           int
	createCalls           int
	removeCalls           int
	removedParticipantRef string
	// scopes records the scope of every call, in order.
	scopes []mediaplane.Scope
}

func (p *mediaPlaneStub) EnsureEpisode(_ context.Context, input mediaplane.EnsureEpisodeInput) (mediaplane.Episode, error) {
	return mediaplane.Episode{Provider: input.Provider, Ref: "episode-ref"}, nil
}
func (p *mediaPlaneStub) CreateJoin(_ context.Context, input mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	p.createCalls++
	p.scopes = append(p.scopes, input.Scope)
	return p.join("new-provider", input.AllowRelay), nil
}

// join builds the payload the provider's adapter builds: Cloudflare names a STUN
// server, the own SFU an Episode reference and its capabilities.
func (p *mediaPlaneStub) join(connection string, allowRelay bool) mediaplane.Join {
	if p.provider == mediaplane.ProviderChalkSFU {
		return mediaplane.Join{Provider: p.provider, ParticipantRef: connection, ClientPayload: map[string]any{
			"connectionId": connection, "provider": "chalk_sfu", "episodeRef": "episode-ref", "iceServers": relayServers(allowRelay),
			"capabilities": map[string]any{"serverLayerAdaptation": true, "subscriptionState": true, "iceRestart": false},
		}}
	}
	return mediaplane.Join{Provider: mediaplane.ProviderCloudflareSFU, ParticipantRef: connection, ClientPayload: map[string]any{"connectionId": connection, "stunServer": "stun:test", "iceServers": relayServers(allowRelay)}}
}

// relayServers mirrors the Cloudflare adapter: TURN only when relay is allowed.
func relayServers(allowRelay bool) []mediaplane.ICEServer {
	servers := []mediaplane.ICEServer{{URLs: []string{"stun:test"}}}
	if allowRelay {
		servers = append(servers, mediaplane.ICEServer{URLs: []string{"turns:turn.test:443?transport=tcp"}, Username: "user", Credential: "secret"})
	}
	return servers
}

func (p *mediaPlaneStub) ResumeJoin(_ context.Context, input mediaplane.ResumeJoinInput) (mediaplane.Join, error) {
	p.resumeCalls++
	p.scopes = append(p.scopes, input.Scope)
	return p.join(input.ConnectionRef, input.AllowRelay), nil
}

func (p *mediaPlaneStub) RemoveParticipant(_ context.Context, input mediaplane.RemoveParticipantInput) error {
	p.removeCalls++
	p.scopes = append(p.scopes, input.Scope)
	p.removedParticipantRef = input.ParticipantRef
	return nil
}
func (p *mediaPlaneStub) EndEpisode(context.Context, mediaplane.EndEpisodeInput) error { return nil }
func (p *mediaPlaneStub) EpisodeUsage(context.Context, mediaplane.EpisodeUsageInput) (mediaplane.Usage, error) {
	return mediaplane.Usage{}, nil
}

func mustID(t *testing.T, raw string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(raw)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestKnockApprovalCollectsOnlyItsOriginalEpisode(t *testing.T) {
	for _, ended := range []bool{false, true} {
		t.Run(map[bool]string{false: "active", true: "ended"}[ended], func(t *testing.T) {
			fixture := newAccessFixture(t)
			pending := fixture.arrival
			pending.State = publicinvites.ArrivalPending
			pending.EpisodeID, pending.ParticipantID = utilities.ID{}, utilities.ID{}
			pending.ParticipantGeneration = 0
			pending.Provider, pending.ProviderSubject = "", ""
			lookup := &approvedAdmissionLookup{publicJoinStub: publicJoinStub{result: fixture.result}}
			if ended {
				lookup.findErr = episodes.ErrEpisodeNotActive
			}
			configuration := fixture.config()
			configuration.Episodes = lookup
			access, err := publicinviteapp.NewAccessPort(configuration)
			if err != nil {
				t.Fatal(err)
			}
			grant, err := access.GrantPublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: pending, Admission: &publicinvites.AdmissionBinding{EpisodeID: fixture.episode, ParticipantID: fixture.participant, ParticipantGeneration: 7}})
			if lookup.joinCalls != 0 || lookup.input.EpisodeID != fixture.episode || lookup.input.ParticipantID != fixture.participant || lookup.input.ParticipantGeneration != 7 {
				t.Fatalf("approval escaped its binding: join calls=%d, lookup=%+v", lookup.joinCalls, lookup.input)
			}
			if ended {
				if !errors.Is(err, publicinvites.ErrArrivalUnavailable) {
					t.Fatalf("ended approval error = %v", err)
				}
				if fixture.plane.createCalls != 0 {
					t.Fatal("ended approval reached media provider")
				}
			} else if err != nil || grant.EpisodeID != fixture.episode || grant.ParticipantID != fixture.participant {
				t.Fatalf("approved grant = %+v, %v", grant, err)
			}
		})
	}
}

type approvedAdmissionLookup struct {
	publicJoinStub
	input     episodes.PublicAccessInput
	findErr   error
	joinCalls int
}

func (s *approvedAdmissionLookup) FindPublic(_ context.Context, input episodes.PublicAccessInput) (episodes.PublicJoinResult, error) {
	s.input = input
	return s.result, s.findErr
}
func (s *approvedAdmissionLookup) JoinPublic(context.Context, episodes.PublicJoinInput) (episodes.PublicJoinResult, error) {
	s.joinCalls++
	return s.result, nil
}

type guardedKnockJoin struct {
	publicJoinStub
	arrival utilities.ID
}

func (s *guardedKnockJoin) JoinPublic(_ context.Context, input episodes.PublicJoinInput) (episodes.PublicJoinResult, error) {
	s.arrival = input.KnockArrivalID
	return episodes.PublicJoinResult{}, publicinvites.ErrArrivalUnavailable
}
func TestLegacyKnockAllocationCarriesArrivalProvenance(t *testing.T) {
	fixture := newAccessFixture(t)
	pending := fixture.arrival
	pending.State = publicinvites.ArrivalPending
	pending.ArrivalHandle = mustID(t, "55555555-5555-4555-8555-555555555555")
	lookup := &guardedKnockJoin{}
	config := fixture.config()
	config.Episodes = lookup
	access, err := publicinviteapp.NewAccessPort(config)
	if err != nil {
		t.Fatal(err)
	}
	_, err = access.GrantPublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: pending, RequireKnock: true})
	if !errors.Is(err, publicinvites.ErrArrivalUnavailable) || lookup.arrival != pending.ArrivalHandle || fixture.plane.createCalls != 0 {
		t.Fatalf("legacy allocation bypassed provenance: arrival=%s media_creates=%d err=%v", lookup.arrival, fixture.plane.createCalls, err)
	}
}

func TestOwnSFUEpisodeGivesANewClientTheOwnSFUPayload(t *testing.T) {
	fixture := newChalkFixture(t)
	access, err := publicinviteapp.NewAccessPort(fixture.config())
	if err != nil {
		t.Fatal(err)
	}
	clients := mediaplane.ParseClientProviders("cloudflare_sfu,chalk_sfu")

	grant, err := access.GrantPublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: fixture.arrival, MediaClients: clients})
	if err != nil {
		t.Fatal(err)
	}

	payload := grant.ClientPayload
	if grant.Provider != "chalk_sfu" || payload.ConnectionID != fixture.arrival.ProviderSubject || payload.EpisodeRef != "episode-ref" || payload.StunServer != "" {
		t.Fatalf("grant = %q %+v, want the own SFU payload on the arrival's connection", grant.Provider, payload)
	}
	if got := payload.Capabilities; !got.ServerLayerAdaptation || !got.SubscriptionState || got.ICERestart {
		t.Fatalf("capabilities = %+v, want the flags the adapter sent", got)
	}
	if got := fixture.issued.subject; got.Provider != accessgrants.ProviderChalkSFU || got.ConnectionID != fixture.arrival.ProviderSubject || got.ProviderSubject != "" {
		t.Fatalf("media proof subject = %+v, want it bound to the own SFU connection", got)
	}
}

func TestOwnSFUEpisodeRefusesAClientThatCannotRunItBeforeAnyProviderWork(t *testing.T) {
	for _, clients := range []mediaplane.ClientProviders{{}, mediaplane.ParseClientProviders("cloudflare_sfu")} {
		fixture := newChalkFixture(t)
		access, err := publicinviteapp.NewAccessPort(fixture.config())
		if err != nil {
			t.Fatal(err)
		}

		_, err = access.GrantPublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: fixture.arrival, MediaClients: clients})

		if !errors.Is(err, mediaplane.ErrClientUnsupported) {
			t.Fatalf("error = %v, want ErrClientUnsupported", err)
		}
		if fixture.plane.createCalls != 0 || fixture.plane.resumeCalls != 0 || fixture.issued.subject.Provider != "" {
			t.Fatalf("a refused client must not touch the provider or get a media proof")
		}
	}
}

func TestCloudflareEpisodeStillServesAClientThatDeclaresNothing(t *testing.T) {
	fixture := newAccessFixture(t)
	access, err := publicinviteapp.NewAccessPort(fixture.config())
	if err != nil {
		t.Fatal(err)
	}

	grant, err := access.GrantPublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: fixture.arrival})
	if err != nil {
		t.Fatal(err)
	}

	if grant.Provider != "cloudflare_sfu" || grant.ClientPayload.StunServer != "stun:test" || grant.ClientPayload.EpisodeRef != "" {
		t.Fatalf("grant = %q %+v, want the Cloudflare payload", grant.Provider, grant.ClientPayload)
	}
}

func TestOwnSFURefreshKeepsTheConnectionAndReplacementIssuesANewOne(t *testing.T) {
	clients := mediaplane.ParseClientProviders("chalk_sfu")
	fixture := newChalkFixture(t)
	config := fixture.config()
	config.MediaProof = fixture.recovery
	access, err := publicinviteapp.NewAccessPort(config)
	if err != nil {
		t.Fatal(err)
	}

	refreshed, err := access.RefreshPublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: fixture.arrival, MediaProof: "proof", MediaClients: clients})
	if err != nil {
		t.Fatal(err)
	}
	replaced, err := access.RefreshPublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: fixture.arrival, MediaProof: "proof", ReplaceMediaConnection: true, MediaClients: clients})
	if err != nil {
		t.Fatal(err)
	}

	if refreshed.ProviderSubject != fixture.arrival.ProviderSubject {
		t.Fatalf("refresh moved the connection to %q", refreshed.ProviderSubject)
	}
	if replaced.ProviderSubject != "new-provider" || replaced.ClientPayload.EpisodeRef != "episode-ref" {
		t.Fatalf("replacement = %q %+v, want a new own SFU connection", replaced.ProviderSubject, replaced.ClientPayload)
	}
}

func TestOwnSFURefreshRejectsAProofForAnotherProvider(t *testing.T) {
	fixture := newChalkFixture(t)
	fixture.recovery.subject.Provider = accessgrants.ProviderCloudflareSFU
	access, err := publicinviteapp.NewAccessPort(fixture.config())
	if err != nil {
		t.Fatal(err)
	}

	_, err = access.RefreshPublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: fixture.arrival, MediaProof: "proof", ReplaceMediaConnection: true, MediaClients: mediaplane.ParseClientProviders("chalk_sfu")})

	if !errors.Is(err, publicinvites.ErrMediaProofRejected) {
		t.Fatalf("error = %v, want the proof rejected", err)
	}
}

func TestFirstJoinCarriesTheGuestsProvidersToEpisodeCreation(t *testing.T) {
	fixture := newChalkFixture(t)
	fixture.arrival.State = publicinvites.ArrivalPending
	fixture.arrival.ProviderSubject = ""
	fixture.arrival.Provider = ""
	access, err := publicinviteapp.NewAccessPort(fixture.config())
	if err != nil {
		t.Fatal(err)
	}
	clients := mediaplane.ParseClientProviders("cloudflare_sfu,chalk_sfu")

	if _, err := access.GrantPublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: fixture.arrival, MediaClients: clients}); err != nil {
		t.Fatal(err)
	}

	if !fixture.joins.joinClient.Runs(mediaplane.ProviderChalkSFU) {
		t.Fatalf("JoinPublic did not get the guest's declared providers")
	}
}

// The own SFU isolates by Tenant, Episode, Participant and generation and
// rejects a call that lacks any of them.
func TestOwnSFUCallsCarryTheParticipantsFullScope(t *testing.T) {
	clients := mediaplane.ParseClientProviders("chalk_sfu")
	fixture := newChalkFixture(t)
	config := fixture.config()
	config.MediaProof = fixture.recovery
	access, err := publicinviteapp.NewAccessPort(config)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := access.RefreshPublicAccess(ctx, publicinvites.PublicAccessInput{Arrival: fixture.arrival, MediaProof: "proof", MediaClients: clients}); err != nil {
		t.Fatal(err)
	}
	replaced, err := access.RefreshPublicAccess(ctx, publicinvites.PublicAccessInput{Arrival: fixture.arrival, MediaProof: "proof", ReplaceMediaConnection: true, MediaClients: clients})
	if err != nil {
		t.Fatal(err)
	}
	if err := access.DiscardPublicAccess(ctx, replaced); err != nil {
		t.Fatal(err)
	}
	if err := access.RevokePublicAccess(ctx, publicinvites.PublicAccessInput{Arrival: fixture.arrival}); err != nil {
		t.Fatal(err)
	}

	if len(fixture.plane.scopes) != 4 {
		t.Fatalf("recorded %d scopes, want resume, create, discard and leave", len(fixture.plane.scopes))
	}
	for i, scope := range fixture.plane.scopes {
		if scope.TenantID == "" || scope.EpisodeID == "" || scope.ParticipantID == "" || scope.Generation <= 0 {
			t.Fatalf("call %d scope = %+v, want all four parts", i, scope)
		}
	}
}
