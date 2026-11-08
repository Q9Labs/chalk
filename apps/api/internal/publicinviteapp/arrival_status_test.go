package publicinviteapp

import (
	"context"
	"errors"
	"fmt"
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

func TestAdmittedStatusSurvivesLostMediaConnection(t *testing.T) {
	for _, test := range []struct {
		name      string
		provider  mediaplane.Provider
		resumeErr error
		wantGrant bool
	}{
		{"lost Chalk SFU session", mediaplane.ProviderChalkSFU, fmt.Errorf("resume join: %w", mediaplane.ErrConnectionNotFound), false},
		{"live Chalk SFU session", mediaplane.ProviderChalkSFU, nil, true},
		{"Cloudflare unchanged", mediaplane.ProviderCloudflareSFU, nil, true},
		{"provider failure is not hidden", mediaplane.ProviderChalkSFU, mediaplane.ErrProviderFailed, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture, access := newArrivalStatusFixture(t, test.provider)
			fixture.resumeErr = test.resumeErr
			runtime, err := publicinvites.NewRuntime(publicinvites.NewService(fixture, publicinvites.Signer{}), fixture, fixture, access, fixture, fixture)
			if err != nil {
				t.Fatal(err)
			}
			result, err := runtime.Status(context.Background(), publicinvites.PublicInviteArrivalStatusInput{
				ArrivalHandle: fixture.arrival.ArrivalHandle.String(), GuestCredential: "guest-credential-for-test",
				MediaClients: mediaplane.ParseClientProviders(string(test.provider)),
			}, func() error { return nil })
			if errors.Is(test.resumeErr, mediaplane.ErrProviderFailed) {
				if !errors.Is(err, test.resumeErr) {
					t.Fatalf("provider failure = %v", err)
				}
				return
			}
			if err != nil || result.State != publicinvites.ArrivalAdmitted || (result.Access != nil) != test.wantGrant {
				t.Fatalf("status = %+v, %v; want admitted, grant=%v", result, err, test.wantGrant)
			}
			if result.Access != nil && result.Access.ProviderSubject != fixture.arrival.ProviderSubject {
				t.Fatal("status changed the admitted media connection")
			}
			if fixture.creates != 0 {
				t.Fatal("status must not replace a connection without proof")
			}
		})
	}
}

func TestLostConnectionReplacementStillRejectsStaleProof(t *testing.T) {
	fixture, access := newArrivalStatusFixture(t, mediaplane.ProviderChalkSFU)
	fixture.resumeErr = mediaplane.ErrConnectionNotFound
	for _, proof := range []string{"", "stale-proof"} {
		_, err := access.RefreshPublicAccess(context.Background(), publicinvites.PublicAccessInput{
			Arrival: fixture.arrival, MediaProof: proof, ReplaceMediaConnection: true,
			MediaClients: mediaplane.AllClientProviders(),
		})
		if !errors.Is(err, publicinvites.ErrMediaProofRejected) {
			t.Fatalf("proof %q: %v", proof, err)
		}
	}
	if fixture.creates != 0 {
		t.Fatal("invalid proof created a replacement connection")
	}
}

type arrivalStatusFixture struct {
	publicinvites.Repository
	publicinvites.Space
	publicinvites.Lifecycle
	publicinvites.Accounts
	publicinvites.Links
	PublicJoinService
	mediaplane.Plane
	arrival   publicinvites.Arrival
	media     mediaplane.Service
	resumeErr error
	creates   int
}

func newArrivalStatusFixture(t *testing.T, provider mediaplane.Provider) (*arrivalStatusFixture, accessPort) {
	t.Helper()
	id := func() utilities.ID {
		value, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	f := &arrivalStatusFixture{arrival: publicinvites.Arrival{
		ArrivalHandle: id(), TenantID: id(), SpaceID: id(), EpisodeID: id(), ParticipantID: id(),
		ParticipantGeneration: 1, State: publicinvites.ArrivalAdmitted, IdentityMode: publicinvites.IdentityGuest,
		Provider: string(provider), ProviderSubject: "old-connection", DisplayName: "Guest",
	}}
	f.media = mediaplane.NewServiceForProvider(provider, f)
	return f, accessPort{episodes: f, spaces: f, tenants: f, mediaResolver: f, syncTokens: f, mediaTokens: f, mediaProofRecovery: f, readyTimeout: time.Second}
}

func (f *arrivalStatusFixture) GetArrival(context.Context, utilities.ID) (publicinvites.Arrival, error) {
	return f.arrival, nil
}
func (f *arrivalStatusFixture) GetArrivalForCredential(context.Context, utilities.ID, []byte) (publicinvites.Arrival, error) {
	return f.arrival, nil
}
func (f *arrivalStatusFixture) GetPublicSpace(context.Context, utilities.ID, utilities.ID) (publicinvites.PublicSpace, error) {
	return publicinvites.PublicSpace{TenantID: f.arrival.TenantID, SpaceID: f.arrival.SpaceID}, nil
}
func (f *arrivalStatusFixture) GetSpace(context.Context, utilities.ID, utilities.ID) (spaces.Space, error) {
	return spaces.Space{ID: f.arrival.SpaceID, TenantID: f.arrival.TenantID}, nil
}
func (f *arrivalStatusFixture) GetTenant(context.Context, utilities.ID) (tenants.Tenant, error) {
	return tenants.Tenant{ID: f.arrival.TenantID}, nil
}
func (f *arrivalStatusFixture) FindPublic(context.Context, episodes.PublicAccessInput) (episodes.PublicJoinResult, error) {
	return f.ready(), nil
}
func (f *arrivalStatusFixture) WaitPublicParticipantReady(context.Context, episodes.PublicParticipantKey) (episodes.PublicJoinResult, error) {
	return f.ready(), nil
}
func (f *arrivalStatusFixture) ready() episodes.PublicJoinResult {
	a := f.arrival
	return episodes.PublicJoinResult{Episode: episodes.Episode{ID: a.EpisodeID}, Participant: episodes.Participant{ID: a.ParticipantID, TenantID: a.TenantID, SpaceID: a.SpaceID, EpisodeID: a.EpisodeID, Generation: a.ParticipantGeneration}}
}
func (f *arrivalStatusFixture) ResolveEpisode(context.Context, tenants.Tenant, spaces.Space, utilities.ID) (*mediaplane.Service, error) {
	return &f.media, nil
}
func (f *arrivalStatusFixture) EnsureEpisode(context.Context, mediaplane.EnsureEpisodeInput) (mediaplane.Episode, error) {
	return mediaplane.Episode{Provider: f.media.Provider(), Ref: "episode-ref"}, nil
}
func (f *arrivalStatusFixture) ResumeJoin(_ context.Context, input mediaplane.ResumeJoinInput) (mediaplane.Join, error) {
	if f.resumeErr != nil {
		return mediaplane.Join{}, f.resumeErr
	}
	payload := map[string]any{"connectionId": input.ConnectionRef}
	if input.Provider == mediaplane.ProviderChalkSFU {
		payload["episodeRef"] = "episode-ref"
	} else {
		payload["stunServer"] = "stun:test"
	}
	return mediaplane.Join{Provider: input.Provider, ClientPayload: payload}, nil
}
func (f *arrivalStatusFixture) CreateJoin(context.Context, mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	f.creates++
	return mediaplane.Join{}, errors.New("unexpected replacement")
}
func (f *arrivalStatusFixture) IssueForParticipant(context.Context, synctokens.SubjectKey) (synctokens.Token, error) {
	return synctokens.Token{Value: "sync-token"}, nil
}
func (f *arrivalStatusFixture) Issue(context.Context, accessgrants.Subject) (accessgrants.MediaCredential, error) {
	return accessgrants.MediaCredential{Token: "media-proof"}, nil
}
func (f *arrivalStatusFixture) VerifyForRecovery(context.Context, string) (accessgrants.Subject, error) {
	a := f.arrival
	return accessgrants.Subject{TenantID: a.TenantID, SpaceID: a.SpaceID, EpisodeID: a.EpisodeID, ParticipantID: a.ParticipantID, ParticipantGeneration: a.ParticipantGeneration, Provider: a.Provider, ConnectionID: "superseded-connection"}, nil
}
