package httpapi

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
)

func TestAccessGrantRefreshReplayDeadline(t *testing.T) {
	for _, tc := range []struct {
		name   string
		age    time.Duration
		denied bool
	}{
		{"day old consumed token", 24 * time.Hour, true},
		{"at deadline", 5 * time.Minute, true},
		{"just inside deadline", 5*time.Minute - 5*time.Second, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			now := time.Now().UTC()
			public, private, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			oldIssuer, err := accessgrants.NewIssuer(accessgrants.IssuerConfig{Issuer: "chalk", KeyID: "key", PrivateKey: private, Now: func() time.Time { return now.Add(-24 * time.Hour) }})
			if err != nil {
				t.Fatal(err)
			}
			original := participantMediaSubject(t)
			original.CloudflareConnectionID = "original"
			requestToken, err := oldIssuer.Issue(ctx, original)
			if err != nil {
				t.Fatal(err)
			}
			winning := original
			winning.CloudflareConnectionID = "replacement"
			expiredWinner, err := oldIssuer.Issue(ctx, winning)
			if err != nil {
				t.Fatal(err)
			}
			cached := newAccessGrantResponse(winning, synctokens.Token{Value: "expired-sync", ExpiresAt: now.Add(-23 * time.Hour)}, expiredWinner, mediaplane.Join{Provider: mediaplane.ProviderCloudflareSFU, ClientPayload: map[string]any{"connectionId": "replacement"}})
			encoded, err := json.Marshal(cached)
			if err != nil {
				t.Fatal(err)
			}
			sealed, err := accessgrants.SealRefreshReplay(requestToken.Token, encoded)
			if err != nil {
				t.Fatal(err)
			}
			repo := &refreshGrantRepository{
				current:    synctokens.Input{TenantID: original.TenantID, SpaceID: original.SpaceID, EpisodeID: original.EpisodeID, ParticipantID: original.ParticipantID, ParticipantGeneration: original.ParticipantGeneration},
				connection: "replacement",
				replays:    map[[32]byte]refreshReplayRecord{sealed.RequestHash: {createdAt: now.Add(-tc.age), connection: "replacement", ciphertext: sealed.Ciphertext}},
			}
			freshIssuer, err := accessgrants.NewIssuer(accessgrants.IssuerConfig{Issuer: "chalk", KeyID: "key", PrivateKey: private})
			if err != nil {
				t.Fatal(err)
			}
			verifier, err := accessgrants.NewVerifier(accessgrants.VerifierConfig{Issuer: "chalk", VerificationKeys: map[string]ed25519.PublicKey{"key": public}})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := verifier.Verify(ctx, requestToken.Token); !errors.Is(err, accessgrants.ErrExpired) {
				t.Fatal("request must be expired")
			}
			if err := repo.CheckParticipantMediaConnection(ctx, synctokens.SubjectKey{}, original.ParticipantGeneration, "original"); !errors.Is(err, accessgrants.ErrConnectionSuperseded) {
				t.Fatal("original binding must be revoked")
			}
			fixture := &refreshGrantPlane{issuer: freshIssuer}
			active := accessgrants.NewActiveAuthorizer(repo)
			endpoint := issueAccessGrantEndpoint(fixture, fixture, verifier, active, active, fixture, fixture, fixture, fixture)
			ctx = authentication.ContextWithPrincipal(ctx, authentication.Principal{Kind: authentication.PrincipalUser, UserID: original.ParticipantID})
			request := issueAccessGrantRequest{TenantID: original.TenantID, SpaceID: original.SpaceID, EpisodeID: original.EpisodeID, ParticipantID: original.ParticipantID, Body: issueAccessGrantBody{ParticipantGeneration: original.ParticipantGeneration, CurrentMediaToken: requestToken.Token}}
			grant, err := endpoint.handle(ctx, request)
			if tc.denied {
				if err == nil || accessGrantAPIError(err).Code != "participant.connection_superseded" {
					t.Fatalf("consumed request past replay deadline: grant=%v err=%v", grant.Media.Token != "", err)
				}
				if fixture.created != 0 || fixture.resumed != 0 {
					t.Fatal("expired replay touched media")
				}
				current, err := freshIssuer.Issue(ctx, winning)
				if err != nil {
					t.Fatal(err)
				}
				request.Body.CurrentMediaToken = current.Token
				if _, err := endpoint.handle(ctx, request); err != nil {
					t.Fatalf("current credential cannot resume after replay expiry: %v", err)
				}
				request.Body.CurrentMediaToken = ""
				request.Body.ReplaceMediaConnection = true
				if _, err := endpoint.handle(ctx, request); err != nil {
					t.Fatalf("authorized fresh recovery failed: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("inside-deadline replay failed: %v", err)
			}
			verified, err := verifier.Verify(ctx, grant.Media.Token)
			if err != nil || verified.CloudflareConnectionID != "replacement" || fixture.created != 0 || fixture.resumed != 1 {
				t.Fatalf("inside-deadline replay did not renew winning connection: subject=%+v err=%v", verified, err)
			}
			if got := repo.replays[sealed.RequestHash].createdAt; !got.Equal(now.Add(-tc.age)) {
				t.Fatalf("renewal extended replay deadline: created_at=%v", got)
			}
			repeated, err := endpoint.handle(ctx, request)
			if err != nil || repeated.Media.Token != grant.Media.Token || fixture.resumed != 1 {
				t.Fatalf("inside-deadline replay did not retain renewed grant: %v", err)
			}
		})
	}
}
