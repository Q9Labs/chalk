package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// proveOpenAdmissionFence shows that admitting a waiting guest on an opened Space runs under the same
// invite, Space and arrival fence as admitting a knock: a revoked invite, or a Space that left open
// mode, allocates no Participant.
func proveOpenAdmissionFence(t *testing.T, ctx context.Context, pool *pgxpool.Pool, service publicinvites.Service, invite publicinvites.Invite, tenantID, spaceID utilities.ID) {
	t.Helper()
	arrival, err := service.CreateArrival(ctx, publicinvites.CreateArrivalInput{
		TenantID: tenantID, SpaceID: spaceID, Invite: publicinvites.Token{Handle: invite.Handle, Generation: invite.Generation}, InviteStateEpoch: invite.StateEpoch,
		IdentityMode: publicinvites.IdentityGuest, DisplayName: "Open fence guest", GuestCredential: []byte("isolated-test-open-fence-credential"), IdempotencyKey: accountTenantIntegrationID(t).String(),
	})
	if err != nil {
		t.Fatal(err)
	}
	var enabled bool
	var stateEpoch int64
	if err := pool.QueryRow(ctx, `select enabled, state_epoch from space_public_invites where tenant_id=$1 and space_id=$2`, uuid(tenantID), uuid(spaceID)).Scan(&enabled, &stateEpoch); err != nil {
		t.Fatal(err)
	}
	restore := func() {
		if _, err := pool.Exec(context.Background(), `update space_public_invites set enabled=$3, state_epoch=$4 where tenant_id=$1 and space_id=$2`, uuid(tenantID), uuid(spaceID), enabled, stateEpoch); err != nil {
			t.Error(err)
		}
		if _, err := pool.Exec(context.Background(), `update spaces set admission_policy='{"mode":"knock"}' where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(spaceID)); err != nil {
			t.Error(err)
		}
	}
	t.Cleanup(restore)
	for _, mutation := range []struct{ name, query string }{
		{"invite_revoked", `update space_public_invites set enabled=false, state_epoch=state_epoch+1 where tenant_id=$1 and space_id=$2`},
		{"space_left_open", `update spaces set admission_policy='{"mode":"members_only"}' where tenant_id=$1 and id=$2`},
	} {
		t.Run(mutation.name, func(t *testing.T) {
			t.Cleanup(restore)
			if _, err := pool.Exec(ctx, `update spaces set admission_policy='{"mode":"open"}' where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(spaceID)); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, mutation.query, uuid(tenantID), uuid(spaceID)); err != nil {
				t.Fatal(err)
			}
			_, joinErr := NewEpisodeLifecycleRepository(pool).JoinPublic(ctx, episodes.PublicJoinInput{
				TenantID: tenantID, SpaceID: spaceID, PendingArrivalID: arrival.Arrival.ArrivalHandle, AdmissionMode: string(publicinvites.AdmissionOpen),
				IdentityMode: "guest", DisplayName: "Open fence guest", Role: publicinvites.PublicRoleCollaborator, Request: episodes.Request{Key: accountTenantIntegrationID(t).String()},
			})
			if !errors.Is(joinErr, publicinvites.ErrArrivalUnavailable) {
				t.Fatalf("open admission after %s = %v, want an unavailable arrival", mutation.name, joinErr)
			}
			var participants int
			if err := pool.QueryRow(ctx, `select count(*) from participants where tenant_id=$1 and space_id=$2 and name='Open fence guest'`, uuid(tenantID), uuid(spaceID)).Scan(&participants); err != nil || participants != 0 {
				t.Fatalf("open admission after %s left %d Participants, err=%v", mutation.name, participants, err)
			}
		})
	}
}
