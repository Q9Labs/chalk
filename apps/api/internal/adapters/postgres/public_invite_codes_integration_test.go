package postgres

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestPublicInviteCodesMatchGoAndResolveAfterRotation(t *testing.T) {
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

	tenantID, spaceID := publicInviteCodeID(t), publicInviteCodeID(t)
	slug := "public-invite-code-" + spaceID.String()[:8]
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `delete from space_public_invites where tenant_id = $1 and space_id = $2`, uuid(tenantID), uuid(spaceID))
		_, _ = pool.Exec(cleanupCtx, `delete from spaces where tenant_id = $1 and id = $2`, uuid(tenantID), uuid(spaceID))
		_, _ = pool.Exec(cleanupCtx, `delete from tenants where id = $1`, uuid(tenantID))
		pool.Close()
	})
	if _, err := pool.Exec(ctx, `insert into tenants (id, name) values ($1, $2)`, uuid(tenantID), "Public invite code integration"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into spaces (id, tenant_id, name, slug, media_plane) values ($1, $2, $3, $4, 'cf_sfu')`, uuid(spaceID), uuid(tenantID), "Public invite code integration", slug); err != nil {
		t.Fatal(err)
	}

	repository := NewPublicInviteRepositoryWithPool(pool)
	service := publicinvites.NewService(repository)
	invite, err := service.EnsureInvite(ctx, tenantID, spaceID, utilities.ID{}, publicinvites.AdmissionOpen)
	if err != nil {
		t.Fatal(err)
	}
	assertStoredInviteCode(t, ctx, pool, repository, invite)

	rotated, err := service.RotateInvite(ctx, tenantID, spaceID, utilities.ID{}, "public-invite-code-rotation")
	if err != nil {
		t.Fatal(err)
	}
	assertStoredInviteCode(t, ctx, pool, repository, rotated)
}

func assertStoredInviteCode(t *testing.T, ctx context.Context, pool *pgxpool.Pool, repository PublicInviteRepository, invite publicinvites.Invite) {
	t.Helper()
	var stored string
	if err := pool.QueryRow(ctx, `select invite_code from space_public_invites where tenant_id = $1 and space_id = $2`, uuid(invite.TenantID), uuid(invite.SpaceID)).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	want := publicinvites.InviteCode(invite.Handle)
	if stored != want {
		t.Fatalf("stored invite code = %q, want %q", stored, want)
	}
	resolved, err := repository.GetInviteByCode(ctx, want)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.TenantID != invite.TenantID || resolved.SpaceID != invite.SpaceID || string(resolved.Handle) != string(invite.Handle) {
		t.Fatalf("resolved invite = %+v, want %+v", resolved, invite)
	}
}

func publicInviteCodeID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}
