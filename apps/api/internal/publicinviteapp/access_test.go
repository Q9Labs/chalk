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

	fixture.recovery.subject.CloudflareConnectionID = "stale-provider"
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
}

func newAccessFixture(t *testing.T) *accessFixture {
	t.Helper()
	tenant := mustID(t, "11111111-1111-4111-8111-111111111111")
	space := mustID(t, "22222222-2222-4222-8222-222222222222")
	episode := mustID(t, "33333333-3333-4333-8333-333333333333")
	participant := mustID(t, "44444444-4444-4444-8444-444444444444")
	proofSubject := accessgrants.Subject{TenantID: tenant, SpaceID: space, EpisodeID: episode, ParticipantID: participant, ParticipantGeneration: 7, Provider: accessgrants.ProviderCloudflareSFU, CloudflareConnectionID: "old-provider"}
	result := episodes.PublicJoinResult{Episode: episodes.Episode{ID: episode, TenantID: tenant, SpaceID: space}, Participant: episodes.Participant{ID: participant, TenantID: tenant, SpaceID: space, EpisodeID: episode, Generation: 7}}
	return &accessFixture{
		tenant: tenant, space: space, episode: episode, participant: participant,
		arrival: publicinvites.Arrival{TenantID: tenant, SpaceID: space, EpisodeID: episode, ParticipantID: participant, ParticipantGeneration: 7, Provider: publicinvites.PublicProviderCloudflareSFU, ProviderSubject: "old-provider", IdentityMode: publicinvites.IdentityGuest, DisplayName: "Trace Guest", State: publicinvites.ArrivalAdmitted},
		result:  result, plane: &mediaPlaneStub{}, recovery: &proofVerifierStub{subject: proofSubject},
	}
}

func (f *accessFixture) config() publicinviteapp.AccessConfig {
	service := mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareSFU, f.plane)
	return publicinviteapp.AccessConfig{
		Episodes: publicJoinStub{result: f.result}, Spaces: publicSpaceStub{tenantID: f.tenant, spaceID: f.space}, Tenants: publicTenantStub{id: f.tenant},
		MediaResolver: mediaResolverStub{service: &service},
		SyncTokens:    syncIssuerStub{}, MediaTokens: mediaIssuerStub{}, MediaProofRecovery: f.recovery,
	}
}

type publicJoinStub struct{ result episodes.PublicJoinResult }

func (s publicJoinStub) JoinPublic(context.Context, episodes.PublicJoinInput) (episodes.PublicJoinResult, error) {
	return s.result, nil
}
func (s publicJoinStub) FindPublic(context.Context, episodes.PublicAccessInput) (episodes.PublicJoinResult, error) {
	return s.result, nil
}
func (s publicJoinStub) LeavePublic(context.Context, episodes.PublicLeaveInput) (episodes.PublicLeaveResult, error) {
	return episodes.PublicLeaveResult{}, nil
}
func (s publicJoinStub) WaitPublicParticipantReady(context.Context, episodes.PublicParticipantKey) (episodes.PublicJoinResult, error) {
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

func (s mediaResolverStub) Resolve(context.Context, tenants.Tenant, spaces.Space) (*mediaplane.Service, error) {
	return s.service, nil
}

type syncIssuerStub struct{}

func (syncIssuerStub) IssueForParticipant(context.Context, synctokens.SubjectKey) (synctokens.Token, error) {
	return synctokens.Token{Value: "sync-token", ExpiresAt: time.Now().Add(time.Minute)}, nil
}

type mediaIssuerStub struct{}

func (mediaIssuerStub) Issue(context.Context, accessgrants.Subject) (accessgrants.MediaCredential, error) {
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
	resumeCalls           int
	createCalls           int
	removeCalls           int
	removedParticipantRef string
}

func (p *mediaPlaneStub) EnsureEpisode(_ context.Context, input mediaplane.EnsureEpisodeInput) (mediaplane.Episode, error) {
	return mediaplane.Episode{Provider: input.Provider, Ref: "episode-ref"}, nil
}
func (p *mediaPlaneStub) CreateJoin(context.Context, mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	p.createCalls++
	return mediaplane.Join{Provider: mediaplane.ProviderCloudflareSFU, ParticipantRef: "new-provider", ClientPayload: map[string]any{"connectionId": "new-provider", "stunServer": "stun:test"}}, nil
}

func (p *mediaPlaneStub) ResumeJoin(_ context.Context, input mediaplane.ResumeJoinInput) (mediaplane.Join, error) {
	p.resumeCalls++
	return mediaplane.Join{Provider: input.Provider, ParticipantRef: input.ConnectionRef, ClientPayload: map[string]any{"connectionId": input.ConnectionRef, "stunServer": "stun:test"}}, nil
}

func (p *mediaPlaneStub) RemoveParticipant(_ context.Context, input mediaplane.RemoveParticipantInput) error {
	p.removeCalls++
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
