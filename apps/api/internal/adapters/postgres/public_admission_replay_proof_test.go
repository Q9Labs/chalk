package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func proveReservedAdmissionReplays(t *testing.T, ctx context.Context, pool *pgxpool.Pool, service publicinvites.Service, tenantID, spaceID, episodeID, actorID utilities.ID, newKnock func(string) (publicinvites.Arrival, publicinvites.AdmissionRequest)) {
	for _, decision := range []publicinvites.AdmissionDecision{publicinvites.DecisionApprove, publicinvites.DecisionDeny} {
		for _, mutation := range []struct{ name, change, restore string }{
			{"arrival_expired", `update space_public_arrivals set expires_at=now()-interval '1 second' where arrival_handle=$3`, `update space_public_arrivals set expires_at=now()+interval '15 minutes' where arrival_handle=$3`},
			{"invite_disabled", `update space_public_invites set enabled=false where tenant_id=$1 and space_id=$2`, `update space_public_invites set enabled=true where tenant_id=$1 and space_id=$2`},
			{"invite_rotated", `update space_public_invites set state_epoch=state_epoch+1 where tenant_id=$1 and space_id=$2`, `update space_public_invites set state_epoch=state_epoch-1 where tenant_id=$1 and space_id=$2`},
			{"policy_changed", `update spaces set admission_policy='{"mode":"members_only"}' where tenant_id=$1 and id=$2`, `update spaces set admission_policy='{"mode":"knock"}' where tenant_id=$1 and id=$2`},
			{"space_archived", `update spaces set archived_at=now() where tenant_id=$1 and id=$2`, `update spaces set archived_at=null where tenant_id=$1 and id=$2`},
			{"episode_ended", `update episodes set status='ended',ended_at=now() where tenant_id=$1 and space_id=$2 and id=$4`, `update episodes set status='active',ended_at=null where tenant_id=$1 and space_id=$2 and id=$4`},
		} {
			t.Run(string(decision)+"/"+mutation.name, func(t *testing.T) {
				arrival, request := newKnock("Reserved " + string(decision) + " " + mutation.name)
				input := publicinvites.DecideAdmissionRequestInput{TenantID: tenantID, SpaceID: spaceID, RequestHandle: request.RequestHandle, ActorID: actorID, RequestKey: accountTenantIntegrationID(t).String(), Decision: decision}
				// Supply typed unused parameters too, so every mutation uses one binding.
				exec := func(query string) error {
					_, err := pool.Exec(ctx, `with binding as (select $1::uuid, $2::uuid, $3::uuid, $4::uuid) `+query, uuid(tenantID), uuid(spaceID), uuid(arrival.ArrivalHandle), uuid(episodeID))
					return err
				}
				// New decisions must still validate mutable state. Replay is
				// special only after an operation has actually been reserved.
				if err := exec(mutation.change); err != nil {
					t.Fatal(err)
				}
				_, _, validationErr := service.DecideAdmissionRequest(ctx, input)
				if err := exec(mutation.restore); err != nil {
					t.Fatal(err)
				}
				if !errors.Is(validationErr, publicinvites.ErrAdmissionRequestTerminal) {
					t.Fatalf("new decision accepted after %s: %v", mutation.name, validationErr)
				}
				if _, _, err := service.DecideAdmissionRequest(ctx, input); err != nil {
					t.Fatal(err)
				}
				if err := exec(mutation.change); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() {
					if err := exec(mutation.restore); err != nil {
						t.Error(err)
					}
				})
				if _, _, err := service.DecideAdmissionRequest(ctx, input); err != nil {
					t.Fatalf("accepted decision replay rejected after %s: %v", mutation.name, err)
				}
				opposite := input
				opposite.Decision = publicinvites.DecisionApprove
				if decision == publicinvites.DecisionApprove {
					opposite.Decision = publicinvites.DecisionDeny
				}
				if _, _, err := service.DecideAdmissionRequest(ctx, opposite); !errors.Is(err, publicinvites.ErrAdmissionRequestTerminal) {
					t.Fatalf("opposite reserved decision = %v", err)
				}
				var count int
				if err := pool.QueryRow(ctx, `select count(*) from sync_external_operations where tenant_id=$1 and episode_id=$2 and request_key=$3`, uuid(tenantID), uuid(episodeID), input.RequestKey).Scan(&count); err != nil || count != 1 {
					t.Fatalf("replay changed reserved operation count: %d, %v", count, err)
				}
			})
		}
	}
}
