package publicinviteapp_test

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/publicinviteapp"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type recordingSpaces struct {
	spaces.Repository
	created []spaces.CreateSpaceInput
}

func (r *recordingSpaces) CreateSpace(_ context.Context, input spaces.CreateSpaceInput) (spaces.Space, error) {
	r.created = append(r.created, input)
	return spaces.Space{ID: input.ID, TenantID: input.TenantID, Name: input.Name, Slug: input.Slug, AdmissionPolicy: json.RawMessage(`{"mode":"open"}`)}, nil
}

func (r *recordingSpaces) GetSpace(context.Context, utilities.ID, utilities.ID) (spaces.Space, error) {
	return spaces.Space{}, spaces.ErrSpaceNotFound
}

func (r *recordingSpaces) CreateSpaceIdempotent(ctx context.Context, input spaces.CreateSpaceInput) (spaces.Space, error) {
	return r.CreateSpace(ctx, input)
}

func TestStartACallBoundsSpaceNameWithoutRejectingDisplayName(t *testing.T) {
	for _, name := range []string{strings.Repeat("a", 200), strings.Repeat("b", publicinvites.MaxDisplayNameBytes)} {
		t.Run(name[:8], func(t *testing.T) {
			tenantID, err := utilities.NewID()
			if err != nil {
				t.Fatal(err)
			}
			repo := &recordingSpaces{}
			port, err := publicinviteapp.NewSpacePort(spaces.NewService(repo), managedTenants{}, publicinviteapp.SpaceConfig{
				ManagedTenantID: tenantID, DefaultMediaPlane: "cf_sfu",
			})
			if err != nil {
				t.Fatal(err)
			}
			private := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
			signer, err := publicinvites.NewSigner(publicinvites.Keyring{CurrentKeyID: "test", Signer: private, Verifiers: map[string]ed25519.PublicKey{"test": private.Public().(ed25519.PublicKey)}})
			if err != nil {
				t.Fatal(err)
			}
			fixture := &publicCallFixture{}
			runtime, err := publicinvites.NewRuntime(publicinvites.NewService(fixture, signer), port, fixture, fixture, fixture, fixture)
			if err != nil {
				t.Fatal(err)
			}
			created, err := runtime.CreatePublicSpace(context.Background(), publicinvites.CreatePublicSpaceInput{
				DisplayName: name, RequestKey: "start-a-call-long-display-name",
			})
			if err != nil {
				t.Fatalf("valid display name must start a call: %v", err)
			}
			want := string([]rune(name)[:spaces.MaxNameCodePoints])
			if created.Presentation.Name != want || !utf8.ValidString(created.Presentation.Name) || len(repo.created) != 1 || repo.created[0].Name != want {
				t.Fatalf("Space name = %q, want %q at a code-point boundary", created.Presentation.Name, want)
			}
			if fixture.participant.DisplayName != name || created.Arrival.Access == nil {
				t.Fatalf("participant name = %q, want the full display name %q and successful call access", fixture.participant.DisplayName, name)
			}
		})
	}
}

func TestPublicSpaceNameTruncatesAtCodePointBoundary(t *testing.T) {
	tenantID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	port, err := publicinviteapp.NewSpacePort(spaces.NewService(&recordingSpaces{}), managedTenants{}, publicinviteapp.SpaceConfig{
		ManagedTenantID: tenantID, DefaultMediaPlane: "cf_sfu",
	})
	if err != nil {
		t.Fatal(err)
	}
	prefix := strings.Repeat("🙂", spaces.MaxNameCodePoints-1) + "🚀"
	created, err := port.CreatePublicSpace(context.Background(), publicinvites.CreatePublicSpaceInput{
		DisplayName: prefix + "suffix", RequestKey: "start-a-call-code-point-boundary",
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.Name != prefix || !utf8.ValidString(created.Name) {
		t.Fatalf("Space name = %q, want %q", created.Name, prefix)
	}
}

type publicCallFixture struct {
	publicinvites.Repository
	publicinvites.Lifecycle
	publicinvites.Access
	publicinvites.Accounts
	participant publicinvites.Arrival
}

func (*publicCallFixture) CreateOrGetInvite(_ context.Context, invite publicinvites.Invite) (publicinvites.Invite, error) {
	return invite, nil
}

func (*publicCallFixture) GetArrivalByIdempotency(context.Context, utilities.ID, utilities.ID, string) (publicinvites.Arrival, error) {
	return publicinvites.Arrival{}, publicinvites.ErrArrivalNotFound
}

func (f *publicCallFixture) CreateArrival(_ context.Context, arrival publicinvites.Arrival) (publicinvites.Arrival, error) {
	arrival.State = publicinvites.ArrivalAdmitted
	f.participant = arrival
	return arrival, nil
}

func (*publicCallFixture) GrantPublicAccess(_ context.Context, input publicinvites.PublicAccessInput) (publicinvites.PublicAccessGrant, error) {
	return publicinvites.PublicAccessGrant{
		TenantID: input.Arrival.TenantID, SpaceID: input.Arrival.SpaceID,
		EpisodeID: input.Arrival.ArrivalHandle, ParticipantID: input.Arrival.ArrivalHandle, ParticipantGeneration: 1,
		Provider: publicinvites.PublicProviderCloudflareSFU, ProviderSubject: "test-provider-subject",
		ClientPayload: publicinvites.PublicAccessClientPayload{ConnectionID: "test-connection", StunServer: "stun.example.test"},
	}, nil
}

func (*publicCallFixture) CreateAutoLifecycle(_ context.Context, lifecycle publicinvites.AutoLifecycle) (publicinvites.AutoLifecycle, error) {
	return lifecycle, nil
}

func (*publicCallFixture) SpaceInviteURL(string, string) (string, error) {
	return "https://example.test/call", nil
}

type managedTenants struct{}

func (managedTenants) GetTenant(context.Context, utilities.ID) (tenants.Tenant, error) {
	return tenants.Tenant{}, nil
}

// A Start-a-call host who leaves and taps Rejoin a few seconds later must land in
// the same call. The Space's linger window is what keeps the Episode open for that
// quick return, so a Start-a-call Space must not be created with a zero window.
func TestStartACallSpaceKeepsLingerWindowForQuickRejoin(t *testing.T) {
	managedTenantID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	spaceService := &recordingSpaces{}
	port, err := publicinviteapp.NewSpacePort(spaceService, managedTenants{}, publicinviteapp.SpaceConfig{
		ManagedTenantID:   managedTenantID,
		DefaultMediaPlane: "cf_sfu",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := port.CreatePublicSpace(context.Background(), publicinvites.CreatePublicSpaceInput{
		DisplayName: "Host",
		RequestKey:  "start-a-call-linger-request-key",
	}); err != nil {
		t.Fatal(err)
	}
	if len(spaceService.created) != 1 {
		t.Fatalf("created %d Spaces, want 1", len(spaceService.created))
	}
	if linger := spaceService.created[0].LingerWindowSeconds; linger <= 0 {
		t.Fatalf("Start-a-call Space linger window = %d seconds, want a window that keeps the call open for a quick Rejoin", linger)
	}
}
