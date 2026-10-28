package httpapi

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
)

func TestAccessGrantRecoveryCompareAndSwap(t *testing.T) {
	for _, takeoverDuringIssue := range []bool{false, true} {
		t.Run(map[bool]string{false: "takeover between recovery attempts", true: "takeover during credential issuance"}[takeoverDuringIssue], func(t *testing.T) {
			subject := participantMediaSubject(t)
			repo := &refreshGrantRepository{current: synctokens.Input{TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID, ParticipantID: subject.ParticipantID, ParticipantGeneration: subject.ParticipantGeneration}, connection: "tab-a"}
			_, private, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			issuer, err := accessgrants.NewIssuer(accessgrants.IssuerConfig{Issuer: "chalk", KeyID: "key", PrivateKey: private})
			if err != nil {
				t.Fatal(err)
			}
			fixture := &refreshGrantPlane{issuer: issuer}
			fixture.connectionID = func() string { return fmt.Sprintf("connection-%d", fixture.created) }
			active := accessgrants.NewActiveAuthorizer(repo)
			endpoint := issueAccessGrantEndpoint(fixture, fixture, &participantMediaVerifierStub{subject: subject}, active, active, fixture, fixture, fixture, fixture)
			ctx := authentication.ContextWithPrincipal(context.Background(), authentication.Principal{Kind: authentication.PrincipalUser, UserID: subject.ParticipantID})
			expected := repo.connection
			request := issueAccessGrantRequest{TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID, ParticipantID: subject.ParticipantID, Body: issueAccessGrantBody{ParticipantGeneration: subject.ParticipantGeneration, ReplaceMediaConnection: true, ExpectedMediaConnectionID: &expected}}
			// A obtains fresh grants while its SFU restarts fail. Each retry must
			// compare against the binding returned by the preceding grant.
			for second := 0; second < 20; second += 5 {
				if _, err := endpoint.handle(ctx, request); err != nil {
					t.Fatal(err)
				}
				expected = repo.connection
			}
			created := fixture.created
			if takeoverDuringIssue {
				fixture.beforeCreate = func() { repo.connection = "tab-b" }
			} else {
				// B explicitly takes over the same generation at recovery second 20.
				takeover := request
				takeover.Body.ExpectedMediaConnectionID = nil
				if _, err := endpoint.handle(ctx, takeover); err != nil {
					t.Fatal(err)
				}
				created = fixture.created
			}
			winner := repo.connection
			if takeoverDuringIssue {
				winner = "tab-b"
			}
			// A retries at second 25, but must not displace B.
			_, err = endpoint.handle(ctx, request)
			if err == nil || accessGrantAPIError(err).Code != "participant.connection_superseded" || accessGrantAPIError(err).Status != 409 {
				t.Fatalf("stale recovery must conflict: %v", err)
			}
			if repo.connection != winner {
				t.Fatal("stale recovery displaced the takeover")
			}
			if !takeoverDuringIssue && fixture.created != created {
				t.Fatal("stale recovery allocated an SFU session")
			}
			// Legacy SDK 5.2.4 and explicit takeover omit the field and keep their behavior.
			fixture.beforeCreate = nil
			legacy := request
			legacy.Body.ExpectedMediaConnectionID = nil
			if _, err := endpoint.handle(ctx, legacy); err != nil {
				t.Fatal(err)
			}
			if repo.connection == winner {
				t.Fatal("explicit takeover did not replace media")
			}
		})
	}
}
