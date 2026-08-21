package postgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestPublicInviteAdmissionRequestUsesLockedArrivalScope(t *testing.T) {
	databaseURL := os.Getenv("CHALK_PUBLIC_INVITES_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("CHALK_PUBLIC_INVITES_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatal(err)
	}

	tenantID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	spaceID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	arrivalID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	slug := "public-invite-admission-" + spaceID.String()[:8]
	inviteHandle := bytesOf(0x21, publicinvites.HandleBytes)
	now := time.Now().UTC()
	future := now.Add(time.Hour)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `delete from space_public_admission_requests where tenant_id = $1 and space_id = $2`, uuid(tenantID), uuid(spaceID))
		_, _ = pool.Exec(cleanupCtx, `delete from space_public_arrivals where tenant_id = $1 and space_id = $2`, uuid(tenantID), uuid(spaceID))
		_, _ = pool.Exec(cleanupCtx, `delete from space_public_invites where tenant_id = $1 and space_id = $2`, uuid(tenantID), uuid(spaceID))
		_, _ = pool.Exec(cleanupCtx, `delete from spaces where tenant_id = $1 and id = $2`, uuid(tenantID), uuid(spaceID))
		_, _ = pool.Exec(cleanupCtx, `delete from tenants where id = $1`, uuid(tenantID))
		pool.Close()
	})
	if _, err := pool.Exec(ctx, `insert into tenants (id, name) values ($1, $2)`, uuid(tenantID), "Public invite admission integration"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into spaces (id, tenant_id, name, slug, media_plane) values ($1, $2, $3, $4, 'cf_rtk')`, uuid(spaceID), uuid(tenantID), "Public invite admission integration", slug); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into space_public_invites (tenant_id, space_id, handle, generation, state_epoch, enabled, public_role, admission_mode) values ($1, $2, $3, 1, 1, true, 'collaborator', 'knock')`, uuid(tenantID), uuid(spaceID), inviteHandle); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into space_public_arrivals (
		arrival_handle, tenant_id, space_id, invite_handle, invite_generation, invite_state_epoch,
		identity_mode, display_name, guest_credential_hash, idempotency_key,
		idempotency_fingerprint, state, expires_at
	) values ($1, $2, $3, $4, 1, 1, 'guest', 'jack', $5, $6, $7, 'pending', $8)`,
		uuid(arrivalID), uuid(tenantID), uuid(spaceID), inviteHandle, bytesOf(0x31, 32),
		"arrival-request-integration", bytesOf(0x41, 32), future,
	); err != nil {
		t.Fatal(err)
	}

	service := publicinvites.NewService(NewPublicInviteRepositoryWithPool(pool)).WithClock(func() time.Time { return now })
	created, err := service.CreateAdmissionRequest(ctx, publicinvites.CreateAdmissionRequestInput{ArrivalHandle: arrivalID, DisplayName: " jack "})
	if err != nil {
		t.Fatalf("create admission request: %v", err)
	}
	replayed, err := service.CreateAdmissionRequest(ctx, publicinvites.CreateAdmissionRequestInput{ArrivalHandle: arrivalID, DisplayName: "jack"})
	if err != nil {
		t.Fatalf("replay admission request: %v", err)
	}
	if created.RequestHandle != replayed.RequestHandle || created.TenantID != tenantID || created.SpaceID != spaceID {
		t.Fatalf("created/replayed admission request scope = %+v / %+v", created, replayed)
	}
	if _, err := service.CreateAdmissionRequest(ctx, publicinvites.CreateAdmissionRequestInput{ArrivalHandle: arrivalID, DisplayName: "jill"}); !errors.Is(err, publicinvites.ErrIdempotencyConflict) {
		t.Fatalf("changed admission request error = %v, want idempotency conflict", err)
	}
}

func TestPublicInviteRepositoryLifecycleRetryRoundTrip(t *testing.T) {
	databaseURL := os.Getenv("CHALK_PUBLIC_INVITES_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("CHALK_PUBLIC_INVITES_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	var lifecycleTable *string
	if err := pool.QueryRow(ctx, `select to_regclass('auto_space_lifecycles')`).Scan(&lifecycleTable); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	if lifecycleTable == nil {
		pool.Close()
		t.Skip("public invite migration has not been applied")
	}

	tenantID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	spaceID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	slug := "public-invite-" + spaceID.String()[:8]
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `delete from auto_space_lifecycles where tenant_id = $1 and space_id = $2`, uuid(tenantID), uuid(spaceID))
		_, _ = pool.Exec(cleanupCtx, `delete from spaces where tenant_id = $1 and id = $2`, uuid(tenantID), uuid(spaceID))
		_, _ = pool.Exec(cleanupCtx, `delete from tenants where id = $1`, uuid(tenantID))
		pool.Close()
	})
	if _, err := pool.Exec(ctx, `insert into tenants (id, name) values ($1, $2)`, uuid(tenantID), "Public invite integration"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into spaces (id, tenant_id, name, slug, media_plane) values ($1, $2, $3, $4, 'cf_rtk')`, uuid(spaceID), uuid(tenantID), "Public invite integration", slug); err != nil {
		t.Fatal(err)
	}

	repository := NewPublicInviteRepositoryWithPool(pool)
	deadline := time.Now().UTC().Add(-time.Minute)
	created, err := repository.CreateAutoLifecycle(ctx, publicinvites.AutoLifecycle{TenantID: tenantID, SpaceID: spaceID, DeadlineAt: deadline, State: publicinvites.AutoLifecycleActive})
	if err != nil {
		t.Fatalf("create lifecycle: %v", err)
	}
	if created.State != publicinvites.AutoLifecycleActive {
		t.Fatalf("created lifecycle state = %q", created.State)
	}
	claimed, err := repository.MarkAutoLifecycleArchiving(ctx, tenantID, spaceID)
	if err != nil {
		t.Fatalf("claim lifecycle: %v", err)
	}
	if claimed.State != publicinvites.AutoLifecycleArchiving {
		t.Fatalf("claimed lifecycle state = %q", claimed.State)
	}
	nextRetry := time.Now().UTC().Add(time.Minute)
	retried, err := repository.RetryAutoLifecycle(ctx, publicinvites.RetryAutoLifecycleInput{
		TenantID: tenantID, SpaceID: spaceID, NextRetryAt: nextRetry, ErrorFamily: "provider_timeout",
	})
	if err != nil {
		t.Fatalf("retry lifecycle: %v", err)
	}
	if retried.State != publicinvites.AutoLifecycleActive || retried.RetryCount != 1 || retried.LastErrorFamily != "provider_timeout" {
		t.Fatalf("retried lifecycle = %+v", retried)
	}
	archived, err := repository.MarkAutoLifecycleArchiving(ctx, tenantID, spaceID)
	if err != nil {
		t.Fatalf("reclaim lifecycle: %v", err)
	}
	if archived.State != publicinvites.AutoLifecycleArchiving {
		t.Fatalf("reclaimed lifecycle state = %q", archived.State)
	}
	archived, err = repository.MarkAutoLifecycleArchived(ctx, tenantID, spaceID)
	if err != nil {
		t.Fatalf("archive lifecycle: %v", err)
	}
	if archived.State != publicinvites.AutoLifecycleArchived || archived.NextRetryAt != nil || archived.LastErrorFamily != "" {
		t.Fatalf("archived lifecycle = %+v", archived)
	}
}

func TestPublicInviteRepositoryDueLifecycleUsesCreatorArrival(t *testing.T) {
	databaseURL := os.Getenv("CHALK_PUBLIC_INVITES_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("CHALK_PUBLIC_INVITES_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	var lifecycleTable *string
	if err := pool.QueryRow(ctx, `select to_regclass('auto_space_lifecycles')`).Scan(&lifecycleTable); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	if lifecycleTable == nil {
		pool.Close()
		t.Skip("public invite migration has not been applied")
	}

	tenantID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	spaceID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	creatorArrivalID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	otherArrivalID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	slug := "public-invite-due-" + spaceID.String()[:8]
	inviteHandle := bytesOf(0x51, publicinvites.HandleBytes)
	fingerprint := bytesOf(0x61, 32)
	credentialHash := bytesOf(0x71, 32)
	now := time.Now().UTC()
	future := now.Add(time.Hour)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `delete from auto_space_lifecycles where tenant_id = $1 and space_id = $2`, uuid(tenantID), uuid(spaceID))
		_, _ = pool.Exec(cleanupCtx, `delete from space_public_arrivals where tenant_id = $1 and space_id = $2`, uuid(tenantID), uuid(spaceID))
		_, _ = pool.Exec(cleanupCtx, `delete from space_public_invites where tenant_id = $1 and space_id = $2`, uuid(tenantID), uuid(spaceID))
		_, _ = pool.Exec(cleanupCtx, `delete from spaces where tenant_id = $1 and id = $2`, uuid(tenantID), uuid(spaceID))
		_, _ = pool.Exec(cleanupCtx, `delete from tenants where id = $1`, uuid(tenantID))
		pool.Close()
	})
	if _, err := pool.Exec(ctx, `insert into tenants (id, name) values ($1, $2)`, uuid(tenantID), "Public invite due integration"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into spaces (id, tenant_id, name, slug, media_plane) values ($1, $2, $3, $4, 'cf_rtk')`, uuid(spaceID), uuid(tenantID), "Public invite due integration", slug); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into space_public_invites (tenant_id, space_id, handle, generation, state_epoch, enabled, public_role, admission_mode) values ($1, $2, $3, 1, 1, true, 'collaborator', 'open')`, uuid(tenantID), uuid(spaceID), inviteHandle); err != nil {
		t.Fatal(err)
	}
	arrivalInsert := `insert into space_public_arrivals (
	arrival_handle, tenant_id, space_id, invite_handle, invite_generation, invite_state_epoch,
	identity_mode, display_name, guest_credential_hash, idempotency_key, idempotency_fingerprint, state, expires_at,
	terminal_reason, terminal_at
) values ($1, $2, $3, $4, 1, 1, 'guest', $5, $6, $7, $8, $9, $10, $11, $12)`
	if _, err := pool.Exec(ctx, arrivalInsert, uuid(creatorArrivalID), uuid(tenantID), uuid(spaceID), inviteHandle, "Creator", credentialHash, "creator-arrival", fingerprint, "pending", future, nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, arrivalInsert, uuid(otherArrivalID), uuid(tenantID), uuid(spaceID), inviteHandle, "Other", credentialHash, "other-arrival", bytesOf(0x62, 32), "rejected", future, "rejected", now); err != nil {
		t.Fatal(err)
	}

	repository := NewPublicInviteRepositoryWithPool(pool)
	lifecycle, err := repository.CreateAutoLifecycle(ctx, publicinvites.AutoLifecycle{
		TenantID: tenantID, SpaceID: spaceID, DeadlineAt: future, CreatorArrivalHandle: creatorArrivalID, State: publicinvites.AutoLifecycleActive,
	})
	if err != nil {
		t.Fatalf("create lifecycle: %v", err)
	}
	due, err := repository.ListDueAutoLifecycles(ctx, now, 10)
	if err != nil {
		t.Fatalf("list pending lifecycle: %v", err)
	}
	if len(due) != 0 {
		t.Fatalf("different terminal arrival triggered lifecycle: %+v", due)
	}
	if _, err := pool.Exec(ctx, `update space_public_arrivals set state = 'rejected', terminal_reason = 'rejected', terminal_at = now() where tenant_id = $1 and space_id = $2 and arrival_handle = $3`, uuid(tenantID), uuid(spaceID), uuid(creatorArrivalID)); err != nil {
		t.Fatal(err)
	}
	due, err = repository.ListDueAutoLifecycles(ctx, now, 10)
	if err != nil {
		t.Fatalf("list creator-terminal lifecycle: %v", err)
	}
	if len(due) != 1 || due[0].TenantID != lifecycle.TenantID || due[0].SpaceID != lifecycle.SpaceID {
		t.Fatalf("creator terminal lifecycle = %+v", due)
	}
	if _, err := repository.MarkAutoLifecycleArchiving(ctx, tenantID, spaceID); err != nil {
		t.Fatalf("claim due lifecycle: %v", err)
	}
	due, err = repository.ListDueAutoLifecycles(ctx, now, 10)
	if err != nil {
		t.Fatalf("list freshly claimed lifecycle: %v", err)
	}
	if len(due) != 0 {
		t.Fatalf("fresh archiving claim was returned: %+v", due)
	}
	if _, err := pool.Exec(ctx, `update auto_space_lifecycles set claim_expires_at = now() - interval '1 second' where tenant_id = $1 and space_id = $2`, uuid(tenantID), uuid(spaceID)); err != nil {
		t.Fatal(err)
	}
	due, err = repository.ListDueAutoLifecycles(ctx, now, 10)
	if err != nil {
		t.Fatalf("list expired claim lifecycle: %v", err)
	}
	if len(due) != 1 || due[0].State != publicinvites.AutoLifecycleActive {
		t.Fatalf("expired archiving claim = %+v", due)
	}
}
