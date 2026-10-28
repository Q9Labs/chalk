package httpapi

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

func TestAccessGrantRecoveryCompareAndSwap(t *testing.T) {
	for _, takeoverDuringIssue := range []bool{false, true} {
		t.Run(map[bool]string{false: "takeover between recovery attempts", true: "takeover during credential issuance"}[takeoverDuringIssue], func(t *testing.T) {
			subject := participantMediaSubject(t)
			subject.CloudflareConnectionID = "tab-a"
			repo := &refreshGrantRepository{current: synctokens.Input{TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID, ParticipantID: subject.ParticipantID, ParticipantGeneration: subject.ParticipantGeneration}, connection: "tab-a"}
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
			credential, err := issuer.Issue(context.Background(), subject)
			if err != nil {
				t.Fatal(err)
			}
			fixture := &recoveryGrantPlane{refreshGrantPlane: refreshGrantPlane{issuer: issuer}}
			active := accessgrants.NewActiveAuthorizer(repo)
			endpoint := issueAccessGrantEndpoint(fixture, fixture, verifier, active, active, fixture, fixture, fixture, fixture)
			ctx := authentication.ContextWithPrincipal(context.Background(), authentication.Principal{Kind: authentication.PrincipalUser, UserID: subject.ParticipantID})
			expected := repo.connection
			request := issueAccessGrantRequest{TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID, ParticipantID: subject.ParticipantID, Body: issueAccessGrantBody{ParticipantGeneration: subject.ParticipantGeneration, CurrentMediaToken: credential.Token, ReplaceMediaConnection: true, ExpectedMediaConnectionID: &expected}}
			missingCredential := request
			missingCredential.Body.CurrentMediaToken = ""
			if _, err := endpoint.handle(ctx, missingCredential); err == nil || fixture.created != 0 {
				t.Fatal("conditional recovery must require a replay credential before allocation")
			}
			// A obtains fresh grants while its SFU restarts fail. Each retry must
			// compare against the binding returned by the preceding grant.
			for second := 0; second < 20; second += 5 {
				grant, err := endpoint.handle(ctx, request)
				if err != nil {
					t.Fatal(err)
				}
				expected = repo.connection
				request.Body.CurrentMediaToken = grant.Media.Token
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

func TestAccessGrantRecoveryReplaysLostResponseOnlyWhileCurrent(t *testing.T) {
	subject := participantMediaSubject(t)
	subject.CloudflareConnectionID = "tab-a"
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
	credential, err := issuer.Issue(context.Background(), subject)
	if err != nil {
		t.Fatal(err)
	}
	repo := &refreshGrantRepository{current: synctokens.Input{TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID, ParticipantID: subject.ParticipantID, ParticipantGeneration: subject.ParticipantGeneration}, connection: subject.CloudflareConnectionID}
	fixture := &recoveryGrantPlane{refreshGrantPlane: refreshGrantPlane{issuer: issuer}}
	active := accessgrants.NewActiveAuthorizer(repo)
	endpoint := issueAccessGrantEndpoint(fixture, fixture, verifier, active, active, fixture, fixture, fixture, fixture)
	ctx := authentication.ContextWithPrincipal(context.Background(), authentication.Principal{Kind: authentication.PrincipalUser, UserID: subject.ParticipantID})
	expected := subject.CloudflareConnectionID
	request := issueAccessGrantRequest{TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID, ParticipantID: subject.ParticipantID, Body: issueAccessGrantBody{ParticipantGeneration: subject.ParticipantGeneration, CurrentMediaToken: credential.Token, ReplaceMediaConnection: true, ExpectedMediaConnectionID: &expected}}
	committed, err := endpoint.handle(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	// The browser never receives this response and retries its original request.
	replayed, err := endpoint.handle(ctx, request)
	if err != nil {
		t.Fatalf("lost replacement response was not replayed: %v", err)
	}
	if replayed.Media.Token != committed.Media.Token || fixture.created != 1 {
		t.Fatal("retry must replay the winning grant without allocating media")
	}
	// A subsequent explicit takeover must invalidate the old replay too.
	takeover := request
	takeover.Body.ExpectedMediaConnectionID = nil
	if _, err := endpoint.handle(ctx, takeover); err != nil {
		t.Fatal(err)
	}
	winner := repo.connection
	_, err = endpoint.handle(ctx, request)
	if err == nil || accessGrantAPIError(err).Code != "participant.connection_superseded" {
		t.Fatal("superseded replay must conflict")
	}
	if repo.connection != winner || fixture.created != 2 {
		t.Fatal("stale replay displaced the takeover or allocated media")
	}
}

func TestAccessGrantRecoveryDuplicateDuringIssuanceIsRetryable(t *testing.T) {
	subject := participantMediaSubject(t)
	subject.CloudflareConnectionID = "tab-a"
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
	credential, err := issuer.Issue(context.Background(), subject)
	if err != nil {
		t.Fatal(err)
	}
	repo := &refreshGrantRepository{current: synctokens.Input{TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID, ParticipantID: subject.ParticipantID, ParticipantGeneration: subject.ParticipantGeneration}, connection: subject.CloudflareConnectionID}
	fixture := &recoveryGrantPlane{refreshGrantPlane: refreshGrantPlane{issuer: issuer}}
	active := accessgrants.NewActiveAuthorizer(repo)
	endpoint := issueAccessGrantEndpoint(fixture, fixture, verifier, active, active, fixture, fixture, fixture, fixture)
	ctx := authentication.ContextWithPrincipal(context.Background(), authentication.Principal{Kind: authentication.PrincipalUser, UserID: subject.ParticipantID})
	expected := subject.CloudflareConnectionID
	request := issueAccessGrantRequest{TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID, ParticipantID: subject.ParticipantID, Body: issueAccessGrantBody{ParticipantGeneration: subject.ParticipantGeneration, CurrentMediaToken: credential.Token, ReplaceMediaConnection: true, ExpectedMediaConnectionID: &expected}}
	var duplicateErr error
	fixture.beforeCreate = func() {
		fixture.beforeCreate = nil
		_, duplicateErr = endpoint.handle(ctx, request)
	}
	committed, err := endpoint.handle(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if duplicateErr == nil || accessGrantAPIError(duplicateErr).Status != 409 || accessGrantAPIError(duplicateErr).Code != "participant.media_replacement_pending" {
		t.Fatalf("identical in-flight replacement must be retryable, not a takeover: %v", duplicateErr)
	}
	replayed, err := endpoint.handle(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if replayed.Media.Token != committed.Media.Token || fixture.created != 1 {
		t.Fatal("duplicate must replay the only allocated media grant")
	}
}

type recoveryGrantPlane struct {
	refreshGrantPlane
}

func (r *refreshGrantRepository) ReserveParticipantMediaRefresh(ctx context.Context, key synctokens.SubjectKey, generation int64, previous, reservation string, requestHash [32]byte) error {
	if r.connection == previous {
		return r.ReplaceParticipantMediaConnection(ctx, key, generation, previous, reservation)
	}
	if r.connection == reservation || r.replays[requestHash].connection == r.connection {
		return accessgrants.ErrRefreshPending
	}
	return accessgrants.ErrConnectionSuperseded
}

func (f *recoveryGrantPlane) CreateJoin(ctx context.Context, input mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	join, err := f.refreshGrantPlane.CreateJoin(ctx, input)
	if err == nil {
		join.ClientPayload["connectionId"] = fmt.Sprintf("connection-%d", f.created)
	}
	return join, err
}

func (f *recoveryGrantPlane) Resolve(context.Context, tenants.Tenant, spaces.Space) (*mediaplane.Service, error) {
	service := mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareSFU, f)
	return &service, nil
}
