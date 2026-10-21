package postgres

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func proveAdmissionProvenanceCollection(t *testing.T, ctx context.Context, pool *pgxpool.Pool, service publicinvites.Service, lifecycle EpisodeLifecycleRepository, tenantID, spaceID, episodeID, accountID utilities.ID, newKnock func(string) (publicinvites.Arrival, publicinvites.AdmissionRequest)) {
	for _, mutation := range []struct{ name, query string }{
		{"invite_disabled", `update space_public_invites set enabled=false, state_epoch=state_epoch+1 where tenant_id=$1 and space_id=$2`},
		{"invite_rotated", `update space_public_invites set handle=decode(repeat('ab',32),'hex'), generation=generation+1, state_epoch=state_epoch+1 where tenant_id=$1 and space_id=$2`},
		{"space_archived", `update spaces set archived_at=now() where tenant_id=$1 and id=$2`},
		{"policy_changed", `update spaces set admission_policy='{"mode":"members_only"}' where tenant_id=$1 and id=$2`},
	} {
		t.Run(mutation.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			arrival, request := newKnock(mutation.name)
			if _, _, err := service.DecideAdmissionRequest(ctx, publicinvites.DecideAdmissionRequestInput{TenantID: tenantID, SpaceID: spaceID, RequestHandle: request.RequestHandle, ActorID: accountID, Decision: publicinvites.DecisionApprove}); err != nil {
				t.Fatal(err)
			}
			exec := func(query string, args ...any) {
				t.Helper()
				if _, err := pool.Exec(ctx, query, args...); err != nil {
					t.Fatal(err)
				}
			}
			exec(`update participants set status='active', joined_at=now() where tenant_id=$1 and id=(select participant_id from sync_admission_requests where tenant_id=$1 and admission_request_id=$2)`, uuid(tenantID), uuid(request.RequestHandle))
			exec(`update sync_admission_requests set status='admitted', completed_at=now() where tenant_id=$1 and admission_request_id=$2`, uuid(tenantID), uuid(request.RequestHandle))
			t.Cleanup(func() {
				_, err := pool.Exec(context.Background(), `update space_public_invites set enabled=true,handle=$3,generation=$4,state_epoch=$5 where tenant_id=$1 and space_id=$2`, uuid(tenantID), uuid(spaceID), arrival.InviteHandle, int64(arrival.InviteGeneration), int64(arrival.InviteStateEpoch))
				if err != nil {
					t.Error(err)
				}
				if _, err := pool.Exec(context.Background(), `update spaces set archived_at=null,admission_policy='{"mode":"knock"}' where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(spaceID)); err != nil {
					t.Error(err)
				}
			})
			cfg := pool.Config()
			cfg.MaxConns = 1
			collector, err := pgxpool.NewWithConfig(ctx, cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { cancel(); collector.Close() }()
			var pid int32
			if err := collector.QueryRow(ctx, `select pg_backend_pid()`).Scan(&pid); err != nil {
				t.Fatal(err)
			}
			ready, commit := make(chan struct{}), make(chan struct{})
			access := &terminalAdmissionAccess{}
			access.grant = func(ctx context.Context, input publicinvites.PublicAccessInput) (publicinvites.PublicAccessGrant, error) {
				binding := input.Admission
				if binding == nil {
					return publicinvites.PublicAccessGrant{}, publicinvites.ErrArrivalUnavailable
				}
				if _, err := lifecycle.FindPublic(ctx, episodes.PublicAccessInput{TenantID: tenantID, SpaceID: spaceID, EpisodeID: binding.EpisodeID, ParticipantID: binding.ParticipantID, ParticipantGeneration: binding.ParticipantGeneration, IdentityMode: "guest"}); err != nil {
					return publicinvites.PublicAccessGrant{}, err
				}
				close(ready)
				select {
				case <-commit:
				case <-ctx.Done():
					return publicinvites.PublicAccessGrant{}, ctx.Err()
				}
				return publicinvites.PublicAccessGrant{TenantID: tenantID, SpaceID: spaceID, EpisodeID: binding.EpisodeID, ParticipantID: binding.ParticipantID, ParticipantGeneration: binding.ParticipantGeneration, Provider: publicinvites.PublicProviderCloudflareSFU, ProviderSubject: "policy-race", ClientPayload: publicinvites.PublicAccessClientPayload{ConnectionID: "policy-race", StunServer: "stun:fixture"}, ExpiresAt: time.Now().Add(time.Hour)}, nil
			}
			repository := NewPublicInviteRepositoryWithPool(collector)
			runtime, err := publicinvites.NewRuntime(publicinvites.NewService(repository), admissionProofSpace{value: publicinvites.PublicSpace{TenantID: tenantID, SpaceID: spaceID, AdmissionMode: publicinvites.AdmissionKnock}}, repository, access, admissionProofAccounts{}, admissionProofLinks{})
			if err != nil {
				t.Fatal(err)
			}
			type outcome struct {
				result publicinvites.PublicSpaceArrival
				err    error
			}
			done := make(chan outcome, 1)
			go func() {
				result, err := runtime.ArrivalStatus(ctx, publicinvites.PublicInviteArrivalStatusInput{ArrivalHandle: arrival.ArrivalHandle.String(), GuestCredential: base64.RawURLEncoding.EncodeToString([]byte("isolated-test-guest-credential"))}, func() error { return nil })
				done <- outcome{result, err}
			}()
			select {
			case <-ready:
			case result := <-done:
				t.Fatalf("collection did not reach the commit barrier: %+v", result)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			blocker, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer blocker.Rollback(context.Background())
			// Both implementations block: the old one on Episode, the fixed one
			// on invite. No policy lock can be taken before the mutation commits.
			for _, lock := range []struct {
				query string
				id    utilities.ID
			}{
				{`select 1 from space_public_invites where tenant_id=$1 and space_id=$2 for update`, spaceID},
				{`select 1 from spaces where tenant_id=$1 and id=$2 for update`, spaceID},
				{`select 1 from episodes where tenant_id=$1 and id=$2 for update`, episodeID},
			} {
				if _, err := blocker.Exec(ctx, lock.query, uuid(tenantID), uuid(lock.id)); err != nil {
					t.Fatal(err)
				}
			}
			close(commit)
			ticker := time.NewTicker(5 * time.Millisecond)
			defer ticker.Stop()
			for {
				var waiting bool
				if err := pool.QueryRow(ctx, `select $2::int=any(pg_blocking_pids($1))`, pid, blocker.Conn().PgConn().PID()).Scan(&waiting); err != nil {
					t.Fatal(err)
				}
				if waiting {
					break
				}
				select {
				case result := <-done:
					t.Fatalf("collection bypassed the database lock barrier: %+v", result)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				case <-ticker.C:
				}
			}
			if _, err := blocker.Exec(ctx, mutation.query, uuid(tenantID), uuid(spaceID)); err != nil {
				t.Fatal(err)
			}
			if err := blocker.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			result := <-done
			if result.err != nil || result.result.State != publicinvites.ArrivalUnavailable || result.result.Access != nil || access.discarded != 1 {
				t.Fatalf("invalidated provenance returned access: state=%s access=%v discarded=%d err=%v", result.result.State, result.result.Access != nil, access.discarded, result.err)
			}
			stored, err := repository.GetArrival(ctx, arrival.ArrivalHandle)
			if err != nil || stored.State != publicinvites.ArrivalUnavailable || stored.ProviderSubject != "" || !stored.EpisodeID.IsZero() {
				t.Fatalf("invalidated provenance persisted a grant: %+v err=%v", stored, err)
			}
		})
	}
}

func proveExpiredPendingArrivalRetry(t *testing.T, ctx context.Context, pool *pgxpool.Pool, repository PublicInviteRepository, invite publicinvites.Invite, tenantID, spaceID utilities.ID) {
	t.Helper()
	private := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
	signer, err := publicinvites.NewSigner(publicinvites.Keyring{CurrentKeyID: "expired-retry", Signer: private, Verifiers: map[string]ed25519.PublicKey{"expired-retry": ed25519.PublicKey(private[ed25519.SeedSize:])}})
	if err != nil {
		t.Fatal(err)
	}
	service := publicinvites.NewService(repository, signer)
	key := accountTenantIntegrationID(t).String()
	credential := []byte("isolated-test-guest-credential")
	arrival, err := service.CreateArrival(ctx, publicinvites.CreateArrivalInput{TenantID: tenantID, SpaceID: spaceID, Invite: publicinvites.Token{Handle: invite.Handle, Generation: invite.Generation}, InviteStateEpoch: invite.StateEpoch, IdentityMode: publicinvites.IdentityGuest, DisplayName: "Expired pending retry", GuestCredential: credential, IdempotencyKey: key})
	if err != nil {
		t.Fatal(err)
	}
	// Simulate a crash after the arrival commit and before knock creation, then
	// advance this disposable row past its deadline. No wall-clock sleep.
	if _, err := pool.Exec(ctx, `update space_public_arrivals set expires_at=now()-interval '1 second' where arrival_handle=$1`, uuid(arrival.Arrival.ArrivalHandle)); err != nil {
		t.Fatal(err)
	}
	token, err := service.IssueInviteToken(invite)
	if err != nil {
		t.Fatal(err)
	}
	access := &terminalAdmissionAccess{grant: func(context.Context, publicinvites.PublicAccessInput) (publicinvites.PublicAccessGrant, error) {
		t.Error("expired retry attempted a grant")
		return publicinvites.PublicAccessGrant{}, publicinvites.ErrArrivalUnavailable
	}}
	runtime, err := publicinvites.NewRuntime(service, admissionProofSpace{value: publicinvites.PublicSpace{TenantID: tenantID, SpaceID: spaceID, AdmissionMode: publicinvites.AdmissionKnock}}, repository, access, admissionProofAccounts{}, admissionProofLinks{})
	if err != nil {
		t.Fatal(err)
	}
	result, retryErr := runtime.Arrive(ctx, publicinvites.PublicInviteArrivalInput{Token: token, DisplayName: "Expired pending retry", RequestKey: key, GuestCredential: base64.RawURLEncoding.EncodeToString(credential)})
	var knocks, reservations int
	if err := pool.QueryRow(ctx, `select (select count(*) from space_public_admission_requests where tenant_id=$1 and space_id=$2 and arrival_handle=$3), (select count(*) from participants where tenant_id=$1 and episode_id in (select id from episodes where tenant_id=$1 and space_id=$2) and name='Expired pending retry')`, uuid(tenantID), uuid(spaceID), uuid(arrival.Arrival.ArrivalHandle)).Scan(&knocks, &reservations); err != nil {
		t.Fatal(err)
	}
	if retryErr != nil || result.State != publicinvites.ArrivalUnavailable || result.Access != nil || knocks != 0 || reservations != 0 {
		t.Fatalf("expired pending retry: state=%s access=%v knocks=%d reservations=%d err=%v", result.State, result.Access != nil, knocks, reservations, retryErr)
	}
	stored, err := repository.GetArrival(ctx, arrival.Arrival.ArrivalHandle)
	if err != nil || stored.State != publicinvites.ArrivalUnavailable {
		t.Fatalf("expired arrival not tombstoned: %+v err=%v", stored, err)
	}
	// The legacy allocator must reject expiry itself, not only a tombstone.
	if _, err := pool.Exec(ctx, `update space_public_arrivals set state='pending',terminal_reason=null where arrival_handle=$1`, uuid(arrival.Arrival.ArrivalHandle)); err != nil {
		t.Fatal(err)
	}
	_, legacyErr := NewEpisodeLifecycleRepository(pool).JoinPublic(ctx, episodes.PublicJoinInput{TenantID: tenantID, SpaceID: spaceID, KnockArrivalID: arrival.Arrival.ArrivalHandle, IdentityMode: "guest", DisplayName: "Expired legacy retry", Role: publicinvites.PublicRoleCollaborator, Request: episodes.Request{Key: accountTenantIntegrationID(t).String()}})
	if !errors.Is(legacyErr, publicinvites.ErrArrivalUnavailable) {
		t.Fatalf("expired legacy allocation = %v", legacyErr)
	}
	if err := pool.QueryRow(ctx, `select count(*) from participants where tenant_id=$1 and space_id=$2 and name='Expired legacy retry'`, uuid(tenantID), uuid(spaceID)).Scan(&reservations); err != nil || reservations != 0 {
		t.Fatalf("expired legacy reservation count=%d err=%v", reservations, err)
	}
}
