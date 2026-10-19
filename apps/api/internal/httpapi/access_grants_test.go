package httpapi

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestReplacementGrantBindsOnlyAfterCredentialsSucceed(t *testing.T) {
	for _, failure := range []string{"sync", "media", "none"} {
		t.Run(failure, func(t *testing.T) {
			fixture := &replacementGrantFixture{failure: failure}
			endpoint := issueAccessGrantEndpoint(fixture, fixture, fixture, fixture, fixture, fixture, fixture, fixture, fixture)
			id, err := utilities.ParseID("11111111-1111-4111-8111-111111111111")
			if err != nil {
				t.Fatal(err)
			}
			ctx := authentication.ContextWithPrincipal(context.Background(), authentication.Principal{Kind: authentication.PrincipalUser, UserID: id})
			_, err = endpoint.handle(ctx, issueAccessGrantRequest{TenantID: id, SpaceID: id, EpisodeID: id, ParticipantID: id, Body: issueAccessGrantBody{ParticipantGeneration: 1, ReplaceMediaConnection: true}})
			if failure == "none" {
				if err != nil || !fixture.bound {
					t.Fatalf("successful replacement: bound=%v err=%v", fixture.bound, err)
				}
			} else if !errors.Is(err, errReplacementCredential) || fixture.bound {
				t.Fatalf("failed grant displaced working connection: bound=%v err=%v", fixture.bound, err)
			}
		})
	}
}

var errReplacementCredential = errors.New("credential unavailable")

type replacementGrantFixture struct {
	SpaceService
	TenantService
	ParticipantMediaVerifier
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
func (f *replacementGrantFixture) Resolve(context.Context, tenants.Tenant, spaces.Space) (*mediaplane.Service, error) {
	service := mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareSFU, f)
	return &service, nil
}
func (*replacementGrantFixture) EnsureEpisode(_ context.Context, input mediaplane.EnsureEpisodeInput) (mediaplane.Episode, error) {
	return mediaplane.Episode{Provider: input.Provider, Ref: input.EpisodeKey}, nil
}
func (*replacementGrantFixture) CreateJoin(context.Context, mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	return mediaplane.Join{Provider: mediaplane.ProviderCloudflareSFU, ClientPayload: map[string]any{"connectionId": "replacement"}}, nil
}
