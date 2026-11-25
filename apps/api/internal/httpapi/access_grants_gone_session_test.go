package httpapi

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// goneSessionPlane is a Chalk SFU whose session for a participant closed as never_connected,
// while the participant's media token is still valid and the participant is still admitted.
type goneSessionPlane struct {
	SpaceService
	TenantService
	mediaplane.Plane
	accessgrants.Issuer
	gone    map[string]bool
	created int
	// overlap runs while a replacement is being created, as a second identical request would.
	overlap func()
}

func (*goneSessionPlane) AuthorizeTenant(context.Context, authentication.Principal, utilities.ID, authorization.TenantPermission) error {
	return nil
}

func (*goneSessionPlane) GetSpace(context.Context, utilities.ID, utilities.ID) (spaces.Space, error) {
	return spaces.Space{}, nil
}

func (*goneSessionPlane) GetTenant(context.Context, utilities.ID) (tenants.Tenant, error) {
	return tenants.Tenant{}, nil
}

func (f *goneSessionPlane) ResolveEpisode(context.Context, tenants.Tenant, spaces.Space, utilities.ID) (*mediaplane.Service, error) {
	service := mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, f)
	return &service, nil
}

func (*goneSessionPlane) EnsureEpisode(_ context.Context, input mediaplane.EnsureEpisodeInput) (mediaplane.Episode, error) {
	return mediaplane.Episode{Provider: input.Provider, Ref: input.EpisodeKey}, nil
}

func (f *goneSessionPlane) CreateJoin(context.Context, mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	if f.overlap != nil {
		f.overlap()
	}
	f.created++
	return mediaplane.Join{Provider: mediaplane.ProviderChalkSFU, ClientPayload: map[string]any{"connectionId": fmt.Sprintf("sfu-new-%d", f.created)}}, nil
}

func (f *goneSessionPlane) ResumeJoin(_ context.Context, input mediaplane.ResumeJoinInput) (mediaplane.Join, error) {
	if f.gone[input.ConnectionRef] {
		return mediaplane.Join{}, mediaplane.ErrConnectionNotFound
	}
	return mediaplane.Join{Provider: mediaplane.ProviderChalkSFU, ClientPayload: map[string]any{"connectionId": input.ConnectionRef}}, nil
}

func (*goneSessionPlane) IssueForParticipant(context.Context, synctokens.SubjectKey) (synctokens.Token, error) {
	return synctokens.Token{Value: "sync", ExpiresAt: time.Now().Add(5 * time.Minute)}, nil
}

// goneSessionRepository holds the one connection bound to the participant and the sealed
// response of the request that replaced it.
type goneSessionRepository struct {
	current    synctokens.Input
	connection string
	replays    map[[32]byte]*accessgrants.StoredRefreshReplay
	replacedBy map[[32]byte]string
}

func (r *goneSessionRepository) GetSyncTokenSubject(context.Context, synctokens.SubjectKey) (synctokens.Input, error) {
	return r.current, nil
}

func (r *goneSessionRepository) SetParticipantMediaConnection(_ context.Context, _ synctokens.SubjectKey, _ int64, connection string) error {
	r.connection = connection
	return nil
}

func (r *goneSessionRepository) CheckParticipantMediaConnection(_ context.Context, _ synctokens.SubjectKey, _ int64, connection string) error {
	if r.connection != connection {
		return accessgrants.ErrConnectionSuperseded
	}
	return nil
}

func (r *goneSessionRepository) ReplaceParticipantMediaConnection(ctx context.Context, key synctokens.SubjectKey, generation int64, previous, next string) error {
	if err := r.CheckParticipantMediaConnection(ctx, key, generation, previous); err != nil {
		return err
	}
	return r.SetParticipantMediaConnection(ctx, key, generation, next)
}

func (r *goneSessionRepository) ReserveParticipantMediaRefresh(ctx context.Context, key synctokens.SubjectKey, generation int64, previous, reservation string, _ [32]byte) error {
	if r.connection == reservation {
		return accessgrants.ErrRefreshPending
	}
	return r.ReplaceParticipantMediaConnection(ctx, key, generation, previous, reservation)
}

func (r *goneSessionRepository) LoadParticipantMediaRefresh(_ context.Context, _ synctokens.SubjectKey, _ int64, requestHash [32]byte) (*accessgrants.StoredRefreshReplay, error) {
	if r.replacedBy[requestHash] != r.connection {
		return nil, nil
	}
	return r.replays[requestHash], nil
}

func (r *goneSessionRepository) CompleteParticipantMediaRefresh(ctx context.Context, key synctokens.SubjectKey, generation int64, previous, next string, replay accessgrants.RefreshReplay) error {
	if err := r.ReplaceParticipantMediaConnection(ctx, key, generation, previous, next); err != nil {
		return err
	}
	r.replays[replay.RequestHash] = &accessgrants.StoredRefreshReplay{Ciphertext: replay.Ciphertext, CreatedAt: time.Now()}
	r.replacedBy[replay.RequestHash] = next
	return nil
}

// A resume whose SFU session is gone is not a revocation: the token holder gets a fresh
// connection exactly as with an expired token, and the replacement is replay-protected.
func TestAccessGrantResumeOfAGoneSFUSessionIsReplacedLikeAnExpiredToken(t *testing.T) {
	ctx := authentication.ContextWithPrincipal(context.Background(), authentication.Principal{Kind: authentication.PrincipalUser, UserID: utilities.ID{}})
	parse := func(value string) utilities.ID {
		t.Helper()
		id, err := utilities.ParseID(value)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	tenantID, spaceID := parse("11111111-1111-4111-8111-111111111111"), parse("22222222-2222-4222-8222-222222222222")
	episodeID, participantID := parse("33333333-3333-4333-8333-333333333333"), parse("44444444-4444-4444-8444-444444444444")
	const generation = 7

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
	plane := &goneSessionPlane{Issuer: issuer, gone: map[string]bool{"sfu-gone": true}}
	repo := &goneSessionRepository{
		current:    synctokens.Input{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: generation},
		connection: "sfu-gone",
		replays:    map[[32]byte]*accessgrants.StoredRefreshReplay{},
		replacedBy: map[[32]byte]string{},
	}
	active := accessgrants.NewActiveAuthorizer(repo)
	endpoint := issueAccessGrantEndpoint(plane, plane, verifier, active, active, plane, plane, plane, plane)

	tokenFor := func(connection string) string {
		t.Helper()
		credential, err := issuer.Issue(ctx, accessgrants.Subject{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: generation, Provider: accessgrants.ProviderChalkSFU, ConnectionID: connection})
		if err != nil {
			t.Fatal(err)
		}
		return credential.Token
	}
	resume := func(token string) (accessGrantResponse, error) {
		return endpoint.handle(ctx, issueAccessGrantRequest{
			TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID,
			MediaClients: mediaplane.AllClientProviders(),
			Body:         issueAccessGrantBody{ParticipantGeneration: generation, CurrentMediaToken: token},
		})
	}
	connectionOf := func(grant accessGrantResponse) string {
		t.Helper()
		subject, err := verifier.Verify(ctx, grant.Media.Token)
		if err != nil {
			t.Fatal(err)
		}
		return subject.ConnectionID
	}

	stale := tokenFor("sfu-gone")
	plane.overlap = func() {
		plane.overlap = nil
		if _, err := resume(stale); err == nil || episodeLifecycleRules.apiError(err).Code != "participant.media_replacement_pending" {
			t.Errorf("an identical resume while the replacement is in flight must be retryable pending: %v", err)
		}
	}
	first, err := resume(stale)
	if err != nil {
		t.Fatalf("resume of a gone SFU session: %v", err)
	}
	if got := connectionOf(first); got != "sfu-new-1" || repo.connection != "sfu-new-1" {
		t.Fatalf("resume did not move the participant to a new connection: token=%q bound=%q", got, repo.connection)
	}

	repeated, err := resume(stale)
	if err != nil || repeated.Media.Token != first.Media.Token || plane.created != 1 {
		t.Fatalf("identical resume must replay the same replacement: err=%v same=%v created=%d", err, repeated.Media.Token == first.Media.Token, plane.created)
	}

	if _, err := resume(tokenFor("sfu-gone")); err == nil || episodeLifecycleRules.apiError(err).Code != "participant.connection_superseded" || plane.created != 1 {
		t.Fatalf("a different resume from the replaced connection must be superseded without a new connection: err=%v created=%d", err, plane.created)
	}

	live, err := resume(tokenFor("sfu-new-1"))
	if err != nil || connectionOf(live) != "sfu-new-1" || plane.created != 1 {
		t.Fatalf("a resume whose session is alive must keep its connection: err=%v created=%d", err, plane.created)
	}
}
