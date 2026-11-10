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

// replayScenario is a refresh whose request token has expired and whose connection another
// request already replaced. The winner's sealed response sits in the replay store at the given age.
type replayScenario struct {
	endpoint     Endpoint[issueAccessGrantRequest, accessGrantResponse]
	request      issueAccessGrantRequest
	verifier     accessgrants.Verifier
	freshIssuer  accessgrants.Issuer
	winning      accessgrants.Subject
	requestToken string
	fixture      *refreshGrantPlane
	repo         *refreshGrantRepository
	requestHash  [32]byte
	replayedAt   time.Time
}

func newReplayScenario(t *testing.T, replayAge time.Duration) replayScenario {
	t.Helper()
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
	original.ConnectionID = "original"
	requestToken, err := oldIssuer.Issue(ctx, original)
	if err != nil {
		t.Fatal(err)
	}
	winning := original
	winning.ConnectionID = "replacement"
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
		replays:    map[[32]byte]refreshReplayRecord{sealed.RequestHash: {createdAt: now.Add(-replayAge), connection: "replacement", ciphertext: sealed.Ciphertext}},
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
	return replayScenario{
		endpoint:     issueAccessGrantEndpoint(fixture, fixture, verifier, active, active, fixture, fixture, fixture, fixture),
		verifier:     verifier,
		freshIssuer:  freshIssuer,
		winning:      winning,
		requestToken: requestToken.Token,
		fixture:      fixture,
		repo:         repo,
		requestHash:  sealed.RequestHash,
		replayedAt:   now.Add(-replayAge),
		request:      issueAccessGrantRequest{TenantID: original.TenantID, SpaceID: original.SpaceID, EpisodeID: original.EpisodeID, ParticipantID: original.ParticipantID, Body: issueAccessGrantBody{ParticipantGeneration: original.ParticipantGeneration, CurrentMediaToken: requestToken.Token}},
	}
}

func (s replayScenario) ctx() context.Context {
	return authentication.ContextWithPrincipal(context.Background(), authentication.Principal{Kind: authentication.PrincipalUser, UserID: s.request.ParticipantID})
}

// Past the replay deadline a consumed request token is refused, and the caller still has two ways
// back in: the current credential, or an explicit replacement.
func TestAccessGrantRefreshReplayPastDeadlineIsRefused(t *testing.T) {
	for name, age := range map[string]time.Duration{"day old consumed token": 24 * time.Hour, "at deadline": 5 * time.Minute} {
		t.Run(name, func(t *testing.T) {
			s := newReplayScenario(t, age)
			grant, err := s.endpoint.handle(s.ctx(), s.request)
			if err == nil || accessGrantAPIError(err).Code != "participant.connection_superseded" {
				t.Fatalf("consumed request past replay deadline: grant=%v err=%v", grant.Media.Token != "", err)
			}
			if s.fixture.created != 0 || s.fixture.resumed != 0 {
				t.Fatalf("refused replay touched media: created=%d resumed=%d", s.fixture.created, s.fixture.resumed)
			}

			current, err := s.freshIssuer.Issue(context.Background(), s.winning)
			if err != nil {
				t.Fatal(err)
			}
			resume := s.request
			resume.Body.CurrentMediaToken = current.Token
			if _, err := s.endpoint.handle(s.ctx(), resume); err != nil {
				t.Fatalf("current credential cannot resume after replay expiry: %v", err)
			}
			replace := s.request
			replace.Body.CurrentMediaToken = ""
			replace.Body.ReplaceMediaConnection = true
			if _, err := s.endpoint.handle(s.ctx(), replace); err != nil {
				t.Fatalf("authorized fresh recovery failed: %v", err)
			}
		})
	}
}

// Just inside the deadline, a retry of the consumed request renews the connection that won, and
// repeating it returns that same grant.
func TestAccessGrantRefreshReplayInsideDeadlineRenewsTheWinningConnection(t *testing.T) {
	s := newReplayScenario(t, 5*time.Minute-5*time.Second)
	grant, err := s.endpoint.handle(s.ctx(), s.request)
	if err != nil {
		t.Fatalf("inside-deadline replay failed: %v", err)
	}
	verified, err := s.verifier.Verify(context.Background(), grant.Media.Token)
	if err != nil || verified.ConnectionID != "replacement" {
		t.Fatalf("inside-deadline replay did not renew winning connection: subject=%+v err=%v", verified, err)
	}
	if s.fixture.created != 0 || s.fixture.resumed != 1 {
		t.Fatalf("renewal must resume the winning connection once: created=%d resumed=%d", s.fixture.created, s.fixture.resumed)
	}
	if got := s.repo.replays[s.requestHash].createdAt; !got.Equal(s.replayedAt) {
		t.Fatalf("renewal extended replay deadline: created_at=%v", got)
	}
	repeated, err := s.endpoint.handle(s.ctx(), s.request)
	if err != nil || repeated.Media.Token != grant.Media.Token {
		t.Fatalf("inside-deadline replay did not retain renewed grant: %v", err)
	}
	if s.fixture.resumed != 1 {
		t.Fatalf("repeating the replay resumed the connection again: resumed=%d", s.fixture.resumed)
	}
}
