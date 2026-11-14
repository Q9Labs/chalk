package httpapi

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// chalkGrantPlane serves an Episode bound to the Chalk SFU.
type chalkGrantPlane struct {
	recoveryGrantPlane
}

func (f *chalkGrantPlane) ResolveEpisode(context.Context, tenants.Tenant, spaces.Space, utilities.ID) (*mediaplane.Service, error) {
	service := mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, f)
	return &service, nil
}

type recoveryGrantPlane struct {
	refreshGrantPlane
}

func (f *recoveryGrantPlane) CreateJoin(ctx context.Context, input mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	join, err := f.refreshGrantPlane.CreateJoin(ctx, input)
	if err == nil {
		join.ClientPayload["connectionId"] = fmt.Sprintf("connection-%d", f.created)
	}
	return join, err
}

func (f *recoveryGrantPlane) ResolveEpisode(context.Context, tenants.Tenant, spaces.Space, utilities.ID) (*mediaplane.Service, error) {
	service := mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareSFU, f)
	return &service, nil
}

type refreshGrantPlane struct {
	replacementGrantFixture
	beforeCreate func()
	created      int
	resumed      int
	issuer       accessgrants.Issuer
}

func (f *refreshGrantPlane) CreateJoin(ctx context.Context, input mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	if f.beforeCreate != nil {
		f.beforeCreate()
	}
	f.created++
	join, err := f.replacementGrantFixture.CreateJoin(ctx, input)
	if err == nil {
		join.ClientPayload["stunServer"] = "stun:stun.cloudflare.com:3478"
	}
	return join, err
}

func (f *refreshGrantPlane) ResumeJoin(_ context.Context, input mediaplane.ResumeJoinInput) (mediaplane.Join, error) {
	f.resumed++
	return mediaplane.Join{Provider: mediaplane.ProviderCloudflareSFU, ClientPayload: map[string]any{"connectionId": input.ConnectionRef, "stunServer": "stun:stun.cloudflare.com:3478"}}, nil
}

func (f *refreshGrantPlane) ResolveEpisode(context.Context, tenants.Tenant, spaces.Space, utilities.ID) (*mediaplane.Service, error) {
	service := mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareSFU, f)
	return &service, nil
}

func (f *refreshGrantPlane) Issue(_ context.Context, subject accessgrants.Subject) (accessgrants.MediaCredential, error) {
	if f.failure == "media" {
		return accessgrants.MediaCredential{}, errReplacementCredential
	}
	return f.issuer.Issue(context.Background(), subject)
}

func (f *refreshGrantPlane) IssueForParticipant(ctx context.Context, key synctokens.SubjectKey) (synctokens.Token, error) {
	token, err := f.replacementGrantFixture.IssueForParticipant(ctx, key)
	if err != nil {
		return synctokens.Token{}, err
	}
	token.Value = strings.Join([]string{"e30", "eyJhdWQiOiJjaGFsay1zeW5jIn0", "fixture"}, ".")
	token.ExpiresAt = time.Now().UTC().Add(5 * time.Minute)
	return token, nil
}

type replacementGrantFixture struct {
	SpaceService
	TenantService
	ParticipantMediaVerifier
	ParticipantGenerationAuthorizer
	ActiveParticipantAuthorizer
	mediaplane.Plane
	failure string
	bound   bool
}

func (*replacementGrantFixture) AuthorizeTenant(context.Context, authentication.Principal, utilities.ID, authorization.TenantPermission) error {
	return nil
}

func (*replacementGrantFixture) AuthorizeActiveParticipantGeneration(context.Context, synctokens.SubjectKey, int64) (bool, error) {
	return true, nil
}

func (f *replacementGrantFixture) BindParticipantMediaConnection(context.Context, accessgrants.Subject) error {
	f.bound = true
	return nil
}

func (f *replacementGrantFixture) IssueForParticipant(context.Context, synctokens.SubjectKey) (synctokens.Token, error) {
	if f.failure == "sync" {
		return synctokens.Token{}, errReplacementCredential
	}
	return synctokens.Token{}, nil
}

func (f *replacementGrantFixture) Issue(context.Context, accessgrants.Subject) (accessgrants.MediaCredential, error) {
	if f.failure == "media" {
		return accessgrants.MediaCredential{}, errReplacementCredential
	}
	return accessgrants.MediaCredential{}, nil
}

func (*replacementGrantFixture) GetSpace(context.Context, utilities.ID, utilities.ID) (spaces.Space, error) {
	return spaces.Space{}, nil
}

func (*replacementGrantFixture) GetTenant(context.Context, utilities.ID) (tenants.Tenant, error) {
	return tenants.Tenant{}, nil
}

func (f *replacementGrantFixture) ResolveEpisode(context.Context, tenants.Tenant, spaces.Space, utilities.ID) (*mediaplane.Service, error) {
	service := mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareSFU, f)
	return &service, nil
}

func (*replacementGrantFixture) EnsureEpisode(_ context.Context, input mediaplane.EnsureEpisodeInput) (mediaplane.Episode, error) {
	return mediaplane.Episode{Provider: input.Provider, Ref: input.EpisodeKey}, nil
}

func (*replacementGrantFixture) CreateJoin(context.Context, mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	return mediaplane.Join{Provider: mediaplane.ProviderCloudflareSFU, ClientPayload: map[string]any{"connectionId": "replacement"}}, nil
}

func participantMediaSubject(t *testing.T) accessgrants.Subject {
	t.Helper()
	return accessgrants.Subject{
		TenantID:              participantMediaID(t, "11111111-1111-4111-8111-111111111111"),
		SpaceID:               participantMediaID(t, "22222222-2222-4222-8222-222222222222"),
		EpisodeID:             participantMediaID(t, "33333333-3333-4333-8333-333333333333"),
		ParticipantID:         participantMediaID(t, "44444444-4444-4444-8444-444444444444"),
		ParticipantGeneration: 7,
		Provider:              accessgrants.ProviderCloudflareSFU,
		ConnectionID:          "connection-123",
	}
}

type refreshGrantRepository struct {
	current    synctokens.Input
	inactive   bool
	connection string
	replays    map[[32]byte]refreshReplayRecord
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

func (r *refreshGrantRepository) LoadParticipantMediaRefresh(_ context.Context, _ synctokens.SubjectKey, _ int64, requestHash [32]byte) (*accessgrants.StoredRefreshReplay, error) {
	record := r.replays[requestHash]
	if record.connection != r.connection {
		return nil, nil
	}
	return &accessgrants.StoredRefreshReplay{Ciphertext: append([]byte(nil), record.ciphertext...), CreatedAt: record.createdAt}, nil
}

func (r *refreshGrantRepository) CompleteParticipantMediaRefresh(ctx context.Context, key synctokens.SubjectKey, generation int64, previous, next string, replay accessgrants.RefreshReplay) error {
	if err := r.ReplaceParticipantMediaConnection(ctx, key, generation, previous, next); err != nil {
		return err
	}
	if r.replays == nil {
		r.replays = make(map[[32]byte]refreshReplayRecord)
	}
	createdAt := r.replays[replay.RequestHash].createdAt
	if createdAt.IsZero() {
		createdAt = time.Now()
	}
	r.replays[replay.RequestHash] = refreshReplayRecord{createdAt: createdAt, connection: next, ciphertext: append([]byte(nil), replay.Ciphertext...)}
	return nil
}

func (r *refreshGrantRepository) GetSyncTokenSubject(context.Context, synctokens.SubjectKey) (synctokens.Input, error) {
	if r.inactive {
		return synctokens.Input{}, synctokens.ErrSubjectNotFound
	}
	return r.current, nil
}

func (r *refreshGrantRepository) SetParticipantMediaConnection(_ context.Context, _ synctokens.SubjectKey, _ int64, connection string) error {
	r.connection = connection
	return nil
}

func (r *refreshGrantRepository) CheckParticipantMediaConnection(_ context.Context, _ synctokens.SubjectKey, _ int64, connection string) error {
	if r.connection != connection {
		return accessgrants.ErrConnectionSuperseded
	}
	return nil
}

func (r *refreshGrantRepository) ReplaceParticipantMediaConnection(ctx context.Context, key synctokens.SubjectKey, generation int64, previous, next string) error {
	if err := r.CheckParticipantMediaConnection(ctx, key, generation, previous); err != nil {
		return err
	}
	return r.SetParticipantMediaConnection(ctx, key, generation, next)
}

type refreshReplayRecord struct {
	createdAt  time.Time
	connection string
	ciphertext []byte
}

type tenantProfileStub struct{ TenantService }

func (tenantProfileStub) GetTenant(_ context.Context, id utilities.ID) (tenants.Tenant, error) {
	return tenants.Tenant{ID: id, Name: "Profile"}, nil
}

// admissionRecorder counts the admissions that would store a Participant.
type admissionRecorder struct {
	EpisodeLifecycleService
	admitted int
}

func (a *admissionRecorder) AdmitParticipant(context.Context, episodes.AdmitParticipantInput) (episodes.Admission, error) {
	a.admitted++
	return episodes.Admission{}, nil
}

var errReplacementCredential = errors.New("credential unavailable")

func participantMediaID(t *testing.T, raw string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(raw)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
