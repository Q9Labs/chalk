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

func TestRefreshReplacementIssuesDiagnostics(t *testing.T) {
	fixture := newAccessFixture(t)
	access, err := publicinviteapp.NewAccessPort(fixture.config())
	if err != nil {
		t.Fatal(err)
	}
	grant, err := access.RefreshPublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: fixture.arrival, MediaProof: "expired-proof", ReplaceMediaConnection: true})
	if err != nil {
		t.Fatal(err)
	}
	if grant.Diagnostics == nil || grant.Diagnostics.Token != "diagnostic-token" {
		t.Fatalf("diagnostics = %#v, want issued credential", grant.Diagnostics)
	}
	if fixture.plane.createCalls != 1 {
		t.Fatalf("create joins = %d, want one replacement", fixture.plane.createCalls)
	}
}

func TestRestoreRejectsChangedPersistedParticipant(t *testing.T) {
	fixture := newAccessFixture(t)
	fixture.result.Participant.Generation++
	access, err := publicinviteapp.NewAccessPort(fixture.config())
	if err != nil {
		t.Fatal(err)
	}
	_, err = access.RestorePublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: fixture.arrival})
	if !errors.Is(err, publicinviteapp.ErrAccessUnavailable) {
		t.Fatalf("restore error = %v, want %v", err, publicinviteapp.ErrAccessUnavailable)
	}
	if fixture.plane.resumeCalls != 0 {
		t.Fatalf("resume calls = %d, want none", fixture.plane.resumeCalls)
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

	fixture.recovery.subject.ProviderSubject = "stale-provider"
	_, err = access.RefreshPublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: fixture.arrival, MediaProof: "stale-proof", ReplaceMediaConnection: true})
	if !errors.Is(err, publicinvites.ErrMediaProofRejected) {
		t.Fatalf("stale proof error = %v, want %v", err, publicinvites.ErrMediaProofRejected)
	}
}

func TestRefreshReplacementPropagatesDiagnosticsIssuerFailure(t *testing.T) {
	fixture := newAccessFixture(t)
	config := fixture.config()
	config.Diagnostics = failingDiagnosticsIssuer{}
	access, err := publicinviteapp.NewAccessPort(config)
	if err != nil {
		t.Fatal(err)
	}
	_, err = access.RefreshPublicAccess(context.Background(), publicinvites.PublicAccessInput{Arrival: fixture.arrival, MediaProof: "proof", ReplaceMediaConnection: true})
	if !errors.Is(err, publicinvites.ErrAccessUnavailable) {
		t.Fatalf("issuer error = %v, want %v", err, publicinvites.ErrAccessUnavailable)
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
	proofSubject := accessgrants.Subject{TenantID: tenant, SpaceID: space, EpisodeID: episode, ParticipantID: participant, ParticipantGeneration: 7, Provider: accessgrants.ProviderCloudflareRTK, ProviderSubject: "old-provider"}
	result := episodes.PublicJoinResult{Episode: episodes.Episode{ID: episode, TenantID: tenant, SpaceID: space}, Participant: episodes.Participant{ID: participant, TenantID: tenant, SpaceID: space, EpisodeID: episode, Generation: 7}}
	return &accessFixture{
		tenant: tenant, space: space, episode: episode, participant: participant,
		arrival: publicinvites.Arrival{TenantID: tenant, SpaceID: space, EpisodeID: episode, ParticipantID: participant, ParticipantGeneration: 7, Provider: publicinvites.PublicProviderCloudflareRTK, ProviderSubject: "old-provider", IdentityMode: publicinvites.IdentityGuest, DisplayName: "Trace Guest", State: publicinvites.ArrivalAdmitted},
		result:  result, plane: &mediaPlaneStub{}, recovery: &proofVerifierStub{subject: proofSubject},
	}
}

func (f *accessFixture) config() publicinviteapp.AccessConfig {
	service := mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareRTK, f.plane)
	return publicinviteapp.AccessConfig{
		Episodes: publicJoinStub{result: f.result}, Spaces: publicSpaceStub{tenantID: f.tenant, spaceID: f.space}, Tenants: publicTenantStub{id: f.tenant},
		MediaResolver: mediaResolverStub{service: &service},
		SyncTokens:    syncIssuerStub{}, MediaTokens: mediaIssuerStub{}, MediaProofRecovery: f.recovery, Diagnostics: diagnosticsIssuerStub{},
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

type diagnosticsIssuerStub struct{}

func (diagnosticsIssuerStub) Issue(context.Context, accessgrants.DiagnosticsSubject) (accessgrants.DiagnosticsCredential, error) {
	return accessgrants.DiagnosticsCredential{Token: "diagnostic-token", ExpiresAt: time.Now().Add(time.Minute), Generation: 1, IntakePath: "/_internal/episode-diagnostic-events"}, nil
}

type failingDiagnosticsIssuer struct{}

func (failingDiagnosticsIssuer) Issue(context.Context, accessgrants.DiagnosticsSubject) (accessgrants.DiagnosticsCredential, error) {
	return accessgrants.DiagnosticsCredential{}, errors.New("diagnostics issuer unavailable")
}

type mediaPlaneStub struct {
	createCalls           int
	resumeCalls           int
	removeCalls           int
	removedParticipantRef string
}

func (p *mediaPlaneStub) EnsureEpisode(_ context.Context, input mediaplane.EnsureEpisodeInput) (mediaplane.Episode, error) {
	return mediaplane.Episode{Provider: input.Provider, Ref: "episode-ref"}, nil
}
func (p *mediaPlaneStub) CreateJoin(context.Context, mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	p.createCalls++
	return mediaplane.Join{Provider: mediaplane.ProviderCloudflareRTK, ParticipantRef: "new-provider", ClientPayload: map[string]any{"token": "provider-token"}}, nil
}
func (p *mediaPlaneStub) ResumeJoin(_ context.Context, input mediaplane.ResumeJoinInput) (mediaplane.Join, error) {
	p.resumeCalls++
	return mediaplane.Join{Provider: input.Provider, ParticipantRef: input.ConnectionRef, ClientPayload: map[string]any{"token": "provider-token"}}, nil
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
