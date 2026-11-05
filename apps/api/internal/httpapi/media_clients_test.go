package httpapi

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// chalkGrantPlane serves an Episode bound to the own SFU.
type chalkGrantPlane struct {
	recoveryGrantPlane
}

func (f *chalkGrantPlane) ResolveEpisode(context.Context, tenants.Tenant, spaces.Space, utilities.ID) (*mediaplane.Service, error) {
	service := mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, f)
	return &service, nil
}

func TestMediaClientsHeaderIsRead(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/", nil)
	if mediaClients(request).Runs(mediaplane.ProviderChalkSFU) {
		t.Fatal("a request without the header runs the own SFU")
	}
	request.Header.Set("X-Chalk-Media-Providers", "cloudflare_sfu,chalk_sfu")
	if !mediaClients(request).Runs(mediaplane.ProviderChalkSFU) {
		t.Fatal("a declared own SFU was not read")
	}
}

func TestAnOldSDKGetsNoOwnSFUGrant(t *testing.T) {
	subject := participantMediaSubject(t)
	repo := &refreshGrantRepository{current: synctokens.Input{TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID, ParticipantID: subject.ParticipantID, ParticipantGeneration: subject.ParticipantGeneration}}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := accessgrants.NewIssuer(accessgrants.IssuerConfig{Issuer: "chalk", KeyID: "key", PrivateKey: private})
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := accessgrants.NewVerifier(accessgrants.VerifierConfig{Issuer: "chalk", VerificationKeys: map[string]ed25519.PublicKey{"key": public}})
	if err != nil {
		t.Fatal(err)
	}
	fixture := &chalkGrantPlane{recoveryGrantPlane{refreshGrantPlane{issuer: issuer}}}
	active := accessgrants.NewActiveAuthorizer(repo)
	endpoint := issueAccessGrantEndpoint(fixture, fixture, verifier, active, active, fixture, fixture, fixture, fixture)
	ctx := authentication.ContextWithPrincipal(context.Background(), authentication.Principal{Kind: authentication.PrincipalUser, UserID: subject.ParticipantID})
	request := issueAccessGrantRequest{TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID, ParticipantID: subject.ParticipantID, Body: issueAccessGrantBody{ParticipantGeneration: subject.ParticipantGeneration, ReplaceMediaConnection: true}}

	_, err = endpoint.handle(ctx, request)
	if apiErr := accessGrantAPIError(err); apiErr.Status != http.StatusConflict || apiErr.Code != "media.client_unsupported" {
		t.Fatalf("an old SDK asking for an own-SFU grant got %v, want 409 media.client_unsupported", err)
	}
	if fixture.created != 0 {
		t.Fatal("an old SDK's refused grant reserved an own-SFU join")
	}

	request.MediaClients = mediaplane.ParseClientProviders("cloudflare_sfu,chalk_sfu")
	if _, err := endpoint.handle(ctx, request); errors.Is(err, mediaplane.ErrClientUnsupported) {
		t.Fatalf("a new SDK was refused: %v", err)
	}
	if fixture.created != 1 {
		t.Fatalf("a new SDK's grant made %d joins, want 1", fixture.created)
	}
}

func TestAnOldSDKIsNotJoinedToAnOwnSFUEpisode(t *testing.T) {
	fixture := &chalkGrantPlane{}
	participant := episodes.Participant{TenantID: participantMediaID(t, "11111111-1111-4111-8111-111111111111"), SpaceID: participantMediaID(t, "22222222-2222-4222-8222-222222222222"), EpisodeID: participantMediaID(t, "33333333-3333-4333-8333-333333333333"), ID: participantMediaID(t, "44444444-4444-4444-8444-444444444444"), Generation: 1}

	_, err := createParticipantJoin(context.Background(), fixture, fixture, fixture, participant, mediaplane.ClientProviders{})
	if !errors.Is(err, mediaplane.ErrClientUnsupported) || fixture.created != 0 {
		t.Fatalf("admission join for an old SDK: %v after %d joins, want ErrClientUnsupported before any join", err, fixture.created)
	}
	if apiErr, ok := episodeLifecycleEndpointAPIError(err); !ok || apiErr.Code != "media.client_unsupported" {
		t.Fatalf("the refusal maps to %+v", apiErr)
	}
	if _, err := createParticipantJoin(context.Background(), fixture, fixture, fixture, participant, mediaplane.ParseClientProviders("chalk_sfu")); errors.Is(err, mediaplane.ErrClientUnsupported) {
		t.Fatalf("a new SDK was refused: %v", err)
	}
}
