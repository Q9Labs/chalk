package postgres

import (
	"context"
	"errors"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/objectcleanup"
	"github.com/q9labs/chalk/apps/api/internal/whiteboardfiles"
)

func TestLegacyWhiteboardReferenceRacesWithFileLifecycle(t *testing.T) {
	if testing.Short() {
		t.Skip("postgres integration")
	}
	databaseURL := os.Getenv(config.DatabaseURL)
	if databaseURL == "" {
		databaseURL = config.DefaultDatabaseURL
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}

	tenant, space, episode := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	scene, participant := accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	begin := func(t *testing.T) pgx.Tx {
		t.Helper()
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return tx
	}
	exec := func(t *testing.T, tx pgx.Tx, query string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}

	seed := begin(t)
	defer seed.Rollback(context.Background())
	exec(t, seed, `insert into tenants(id, name) values ($1, 'Whiteboard file reference race')`, tenant.Bytes())
	exec(t, seed, `insert into spaces(id, name, tenant_id, slug, media_plane) values ($1, 'Board race', $2, $3, $4)`,
		space.Bytes(), tenant.Bytes(), "board-race-"+space.String(), mediaplane.ProviderChalkSFU)
	exec(t, seed, `insert into episodes(id, status, space_id, tenant_id, config_snapshot) values ($1, 'active', $2, $3, '{}')`,
		episode.Bytes(), space.Bytes(), tenant.Bytes())
	exec(t, seed, `insert into participants(id, tenant_id, space_id, episode_id, capabilities, generation, status, role)
		values ($1, $2, $3, $4, '{drawWhiteboard}', 1, 'active', 'collaborator')`,
		participant.Bytes(), tenant.Bytes(), space.Bytes(), episode.Bytes())
	exec(t, seed, `insert into sync_whiteboard_scenes(tenant_id, space_id, episode_id, scene_id) values ($1, $2, $3, $4)`,
		tenant.Bytes(), space.Bytes(), episode.Bytes(), scene.Bytes())
	if err := seed.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		err := pgx.BeginFunc(cleanupCtx, pool, func(tx pgx.Tx) error {
			for _, table := range []string{"sync_whiteboard_scenes", "participants", "episodes", "spaces"} {
				if _, err := tx.Exec(cleanupCtx, "delete from "+table+" where tenant_id = $1", tenant.Bytes()); err != nil {
					return err
				}
			}
			_, err := tx.Exec(cleanupCtx, "delete from tenants where id = $1", tenant.Bytes())
			return err
		})
		if err != nil {
			t.Errorf("remove whiteboard race fixture: %v", err)
		}
	}()

	// The previous release locks the scene, then commits an element without
	// updating or locking the file itself.
	lockScene := func(t *testing.T, tx pgx.Tx) {
		t.Helper()
		exec(t, tx, `select scene_id from sync_whiteboard_scenes where scene_id = $1 for update`, scene.Bytes())
	}
	attach := func(tx pgx.Tx, fileID string) error {
		_, err := tx.Exec(ctx, `insert into sync_whiteboard_elements (
			tenant_id, space_id, episode_id, scene_id, element_id, element_type,
			version, version_nonce, element_index, is_deleted, payload, encoded_bytes
		) values ($1, $2, $3, $4, $5, 'image', 1, 1, 'a0', false,
			jsonb_build_object('fileId', $5::text, 'status', 'saved'), 64)`,
			tenant.Bytes(), space.Bytes(), episode.Bytes(), scene.Bytes(), fileID)
		if err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	request := whiteboardfiles.FileRequest{
		Subject: whiteboardfiles.Subject{
			TenantID: tenant, SpaceID: space, EpisodeID: episode, ParticipantID: participant, ParticipantGeneration: 1,
		},
		SceneID: scene,
	}
	files := NewWhiteboardFileRepository(pool)

	t.Run("first reference overlaps uncommitted finalize", func(t *testing.T) {
		request := request
		request.FileID = "finalize-race"
		uploadID := accountTenantIntegrationID(t)
		objectKey := "fixture/" + uploadID.String()
		_, err := files.Reserve(ctx, whiteboardfiles.Upload{
			Subject: request.Subject, SceneID: scene, FileID: request.FileID, UploadID: uploadID,
			ObjectKey: objectKey, MIMEType: "image/png", ByteLength: 1, ExpiresAt: time.Now().Add(time.Minute),
		})
		if err != nil {
			t.Fatal(err)
		}
		finalize := begin(t)
		defer finalize.Rollback(context.Background())
		ok, err := NewWhiteboardFileRepository(finalize).Finalize(ctx, request, uploadID, "fixture", time.Now().Add(-time.Minute))
		if err != nil || !ok {
			t.Fatalf("finalize in an open transaction: updated=%t, error=%v", ok, err)
		}
		legacy := begin(t)
		defer legacy.Rollback(context.Background())
		lockScene(t, legacy)
		waiterPID := int32(legacy.Conn().PgConn().PID())
		blockerPID := int32(finalize.Conn().PgConn().PID())
		attached := make(chan error, 1)
		go func() { attached <- attach(legacy, request.FileID) }()

		// Release finalize only once the legacy commit has finished or Postgres
		// confirms it is waiting for finalize, not after a guessed sleep.
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		var attachErr error
		var finished, blocked bool
		for !finished && !blocked {
			select {
			case attachErr = <-attached:
				finished = true
			case <-ticker.C:
				err := pool.QueryRow(ctx, `select $2::integer = any(pg_blocking_pids($1::integer))`, waiterPID, blockerPID).Scan(&blocked)
				if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		}
		if err := finalize.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if !finished {
			attachErr = <-attached
		}
		if attachErr != nil {
			t.Fatalf("legacy attachment must succeed once the file is ready: %v", attachErr)
		}
		cleanup := begin(t)
		defer cleanup.Rollback(context.Background())
		now := time.Now()
		claims, err := NewWhiteboardFileRepository(cleanup).ClaimCleanup(ctx, objectcleanup.ClaimInput{
			Now: now, LeaseUntil: now.Add(time.Minute), EndedBefore: now.Add(-time.Hour), Limit: 200,
		})
		if err != nil {
			t.Fatal(err)
		}
		if slices.ContainsFunc(claims, func(claim whiteboardfiles.CleanupClaim) bool { return claim.UploadID == uploadID }) {
			t.Fatal("cleanup claimed a ready file with a committed legacy reference")
		}
	})

	t.Run("first reference arrives after cleanup removed its row", func(t *testing.T) {
		request := request
		request.FileID = "deleted-before-attach"
		uploadID, token := accountTenantIntegrationID(t), accountTenantIntegrationID(t)
		_, err := files.Reserve(ctx, whiteboardfiles.Upload{
			Subject: request.Subject, SceneID: scene, FileID: request.FileID, UploadID: uploadID,
			ObjectKey: "fixture/" + uploadID.String(), MIMEType: "image/png", ByteLength: 1, ExpiresAt: time.Now().Add(time.Minute),
		})
		if err != nil {
			t.Fatal(err)
		}
		legacy := begin(t)
		defer legacy.Rollback(context.Background())
		lockScene(t, legacy)
		cleanup := begin(t)
		defer cleanup.Rollback(context.Background())
		exec(t, cleanup, `update sync_whiteboard_files set cleanup_claim_token = $2, cleanup_claimed_until = now() + interval '1 minute'
			where upload_id = $1`, uploadID.Bytes(), token.Bytes())
		if err := NewWhiteboardFileRepository(cleanup).CompleteCleanup(ctx, whiteboardfiles.CleanupClaim{UploadID: uploadID, Token: token}); err != nil {
			t.Fatal(err)
		}
		if err := cleanup.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		var databaseError *pgconn.PgError
		if err := attach(legacy, request.FileID); !errors.As(err, &databaseError) || databaseError.Code != "23514" {
			t.Fatalf("legacy Sync must not write a reference to a removed file: %v", err)
		}
	})
}
