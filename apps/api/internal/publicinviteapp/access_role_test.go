package publicinviteapp

import (
	"context"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
)

type joinRecorder struct {
	*arrivalStatusFixture
	roles []string
}

func (j *joinRecorder) JoinPublic(_ context.Context, input episodes.PublicJoinInput) (episodes.PublicJoinResult, error) {
	j.roles = append(j.roles, input.Role)
	return j.ready(), nil
}

func TestGrantPublicAccessRole(t *testing.T) {
	for _, tc := range []struct{ name, role, want string }{
		{"a joiner is a collaborator", "", publicinvites.PublicRoleCollaborator},
		{"the person who starts a call is its owner", publicinvites.PublicRoleOwner, publicinvites.PublicRoleOwner},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fixture, access := newArrivalStatusFixture(t, mediaplane.ProviderCloudflareSFU)
			fixture.media = mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareSFU, publicIssuancePlane{fixture})
			joins := &joinRecorder{arrivalStatusFixture: fixture}
			access.episodes = joins
			arrival := fixture.arrival
			arrival.State = publicinvites.ArrivalPending
			if _, err := access.GrantPublicAccess(context.Background(), publicinvites.PublicAccessInput{Role: tc.role, Arrival: arrival}); err != nil {
				t.Fatal(err)
			}
			if len(joins.roles) != 1 || joins.roles[0] != tc.want {
				t.Fatalf("joined as %v, want %q", joins.roles, tc.want)
			}
		})
	}
}
