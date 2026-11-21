package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/whiteboardfiles"
)

func TestWhiteboardFileUploadRetryAuthorizationAndCleanup(t *testing.T) {
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
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())

	tenant, space, episode := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	scene, participant := accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`insert into tenants(id, name) values($1, 'Whiteboard uploads')`, tenant.Bytes())
	exec(`insert into spaces(id, name, tenant_id, slug, media_plane) values($1, 'Whiteboard uploads', $2, $3, 'cf_sfu')`, space.Bytes(), tenant.Bytes(), "wb-"+space.String())
	exec(`insert into episodes(id, status, space_id, tenant_id, config_snapshot) values($1, 'active', $2, $3, '{}')`, episode.Bytes(), space.Bytes(), tenant.Bytes())
	exec(`insert into participants(id, tenant_id, space_id, episode_id, capabilities, generation, status, role)
		values($1, $2, $3, $4, '{drawWhiteboard}', 1, 'active', 'collaborator')`,
		participant.Bytes(), tenant.Bytes(), space.Bytes(), episode.Bytes())
	exec(`insert into sync_whiteboard_scenes(tenant_id, space_id, episode_id, scene_id) values($1, $2, $3, $4)`,
		tenant.Bytes(), space.Bytes(), episode.Bytes(), scene.Bytes())

	t.Run("capture stops retaining annotation at its byte budget", func(t *testing.T) {
		recording := accountTenantIntegrationID(t)
		layer := accountTenantIntegrationID(t)
		exec(`insert into recordings(id, tenant_id, space_id, episode_id, status, storage_provider)
			values ($1, $2, $3, $4, 'completed', 'r2')`, recording.Bytes(), tenant.Bytes(), space.Bytes(), episode.Bytes())
		exec(`insert into recording_screen_annotation_layers (
			tenant_id, space_id, episode_id, recording_id, capture_epoch, layer_id,
			publication_id, sharer_generation, layer, initial_at_ms, initial_revision, initial_paused, initial_marks
		) values ($1, $2, $3, $4, 1, $5, 'screen', 1, '{}', 0, 0, false, '[]')`,
			tenant.Bytes(), space.Bytes(), episode.Bytes(), recording.Bytes(), layer.Bytes())
		exec(`insert into recording_screen_annotation_changes (
			tenant_id, space_id, episode_id, recording_id, capture_epoch, layer_id, revision, at_ms, change
		) select $1, $2, $3, $4, 1, $5, revision, revision, jsonb_build_object('fixture', repeat('x', 32000))
		from generate_series(1, 1050) as revision`, tenant.Bytes(), space.Bytes(), episode.Bytes(), recording.Bytes(), layer.Bytes())
		var retained int
		var closed bool
		err := tx.QueryRow(ctx, `select count(change.revision), layer.closed_at_ms is not null
			from recording_screen_annotation_layers layer
			left join recording_screen_annotation_changes change using (tenant_id, space_id, episode_id, recording_id, capture_epoch, layer_id)
			where layer.recording_id = $1 group by layer.closed_at_ms`, recording.Bytes()).Scan(&retained, &closed)
		if err != nil || retained < 1 || retained >= 1050 || !closed {
			t.Fatalf("expected a bounded prefix with a closed layer, retained=%d closed=%t: %v", retained, closed, err)
		}
	})

	repo := NewWhiteboardFileRepository(tx)
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	data := encoded.Bytes()
	digest := sha256.Sum256(data)
	objects := &whiteboardTestObjectStore{}
	service := whiteboardfiles.NewService(repo, objects)
	input := whiteboardfiles.InitiateInput{
		FileRequest: whiteboardfiles.FileRequest{
			Subject: whiteboardfiles.Subject{
				TenantID: tenant, SpaceID: space, EpisodeID: episode, ParticipantID: participant, ParticipantGeneration: 1,
			},
			SceneID: scene, FileID: "example",
		},
		MIMEType: "image/png", ByteLength: int64(len(data)), SHA256: hex.EncodeToString(digest[:]),
	}
	stale := input
	stale.Subject.ParticipantGeneration++
	if _, err := service.Initiate(ctx, stale); !errors.Is(err, whiteboardfiles.ErrPermissionDenied) {
		t.Fatalf("stale generation initiate: %v", err)
	}
	stale = input
	stale.SceneID = accountTenantIntegrationID(t)
	if _, err := service.Initiate(ctx, stale); !errors.Is(err, whiteboardfiles.ErrPermissionDenied) {
		t.Fatalf("wrong scene initiate: %v", err)
	}
	oversize := input
	oversize.ByteLength = 20*1024*1024 + 1
	if _, err := service.Initiate(ctx, oversize); !errors.Is(err, whiteboardfiles.ErrInvalidInput) {
		t.Fatalf("oversize initiate: %v", err)
	}
	badType := input
	badType.MIMEType = "image/svg+xml"
	if _, err := service.Initiate(ctx, badType); !errors.Is(err, whiteboardfiles.ErrInvalidInput) {
		t.Fatalf("SVG initiate: %v", err)
	}

	first, err := service.Initiate(ctx, input)
	if err != nil || first.Ready || !objects.signed.IfNoneMatch || objects.signed.ContentLength != input.ByteLength {
		t.Fatalf("initiate: ready=%v condition=%v error=%v", first.Ready, objects.signed.IfNoneMatch, err)
	}
	key := objects.signed.Key
	if _, err := service.Initiate(ctx, input); err != nil || objects.signed.Key != key {
		t.Fatalf("repeat initiate did not reuse object key: %v", err)
	}
	t.Run("expired same-byte reservation renews", func(t *testing.T) {
		exec(`update sync_whiteboard_files set expires_at = now() - interval '1 minute' where tenant_id = $1 and file_id = $2`,
			tenant.Bytes(), input.FileID)
		if _, err := service.Initiate(ctx, input); err != nil || objects.signed.Key != key {
			t.Fatalf("retry should renew the original immutable key: %v", err)
		}
	})
	exec(`update sync_whiteboard_files set expires_at = now() + interval '5 minutes' where tenant_id = $1 and file_id = $2`,
		tenant.Bytes(), input.FileID)
	t.Run("header without pixels cannot finalize", func(t *testing.T) {
		truncated := input
		truncated.FileID = "header-only"
		// PNG signature and IHDR including its CRC, but no pixel data.
		objects.data = data[:33]
		digest := sha256.Sum256(objects.data)
		truncated.ByteLength = int64(len(objects.data))
		truncated.SHA256 = hex.EncodeToString(digest[:])
		if _, err := service.Initiate(ctx, truncated); err != nil {
			t.Fatal(err)
		}
		if err := service.Finalize(ctx, truncated.FileRequest, truncated.SHA256); !errors.Is(err, whiteboardfiles.ErrFileTransferFailed) {
			t.Fatalf("finalize must reject missing pixels: %v", err)
		}
	})
	exec(`delete from sync_whiteboard_files where tenant_id = $1 and file_id = 'header-only'`, tenant.Bytes())
	bogus := input
	bogus.SHA256 = hex.EncodeToString(make([]byte, 32))
	if _, err := service.Initiate(ctx, bogus); !errors.Is(err, whiteboardfiles.ErrFileConflict) {
		t.Fatalf("same ID different content: %v", err)
	}
	if _, err := service.Download(ctx, input.Subject, input.FileID); !errors.Is(err, whiteboardfiles.ErrFileNotFound) {
		t.Fatalf("download before finalize: %v", err)
	}
	objects.data = make([]byte, len(data))
	if err := service.Finalize(ctx, input.FileRequest, input.SHA256); !errors.Is(err, whiteboardfiles.ErrFileTransferFailed) {
		t.Fatalf("wrong type finalize: %v", err)
	}
	objects.data = bytes.Clone(data)
	objects.data[len(data)-1] ^= 1
	if err := service.Finalize(ctx, input.FileRequest, input.SHA256); !errors.Is(err, whiteboardfiles.ErrFileTransferFailed) {
		t.Fatalf("wrong digest finalize: %v", err)
	}
	objects.data = data
	exec(`insert into sync_whiteboard_draw_policies (tenant_id, space_id, episode_id, policy, updated_by_participant_id)
		values ($1, $2, $3, 'hosts', $4)`, tenant.Bytes(), space.Bytes(), episode.Bytes(), participant.Bytes())
	if err := service.Finalize(ctx, input.FileRequest, input.SHA256); !errors.Is(err, whiteboardfiles.ErrPermissionDenied) {
		t.Fatalf("revoked finalize: %v", err)
	}
	exec(`update sync_whiteboard_draw_policies set policy = 'everyone' where tenant_id = $1`, tenant.Bytes())
	if err := service.Finalize(ctx, input.FileRequest, input.SHA256); err != nil {
		t.Fatal(err)
	}
	reads := objects.reads
	if err := service.Finalize(ctx, input.FileRequest, input.SHA256); err != nil || objects.reads != reads {
		t.Fatalf("duplicate finalize should not re-read object: %v", err)
	}
	if retry, err := service.Initiate(ctx, input); err != nil || !retry.Ready || retry.URL != "" {
		t.Fatalf("retry after dropped finalize response: ready=%v error=%v", retry.Ready, err)
	}
	if _, err := service.Download(ctx, input.Subject, input.FileID); err != nil {
		t.Fatal(err)
	}

	t.Run("legacy SVG cannot be opened inline", func(t *testing.T) {
		exec(`update sync_whiteboard_files set mime_type = 'image/svg+xml' where tenant_id = $1 and file_id = $2`, tenant.Bytes(), input.FileID)
		if _, err := service.Download(ctx, input.Subject, input.FileID); !errors.Is(err, whiteboardfiles.ErrFileNotFound) {
			t.Fatalf("the API must not sign a browser-navigable legacy SVG: %v", err)
		}
	})
	exec(`update sync_whiteboard_files set mime_type = 'image/png' where tenant_id = $1 and file_id = $2`, tenant.Bytes(), input.FileID)
	t.Run("outstanding uploads have a participant quota", func(t *testing.T) {
		for i := 0; i < 7; i++ {
			upload := input
			upload.FileID = fmt.Sprintf("quota-%d", i)
			if _, err := service.Initiate(ctx, upload); err != nil {
				t.Fatal(err)
			}
		}
		upload := input
		upload.FileID = "quota-extra"
		if _, err := service.Initiate(ctx, upload); err == nil {
			t.Fatal("ninth outstanding reservation succeeded")
		}
		if upload, err := service.Initiate(ctx, input); err != nil || !upload.Ready {
			t.Fatalf("quota must not block idempotent retries: %v", err)
		}
	})
	exec(`delete from sync_whiteboard_files where tenant_id = $1 and file_id like 'quota-%'`, tenant.Bytes())

	pending := input
	pending.FileID = "abandoned"
	if _, err := service.Initiate(ctx, pending); err != nil {
		t.Fatal(err)
	}
	pendingKey := objects.signed.Key
	referenced := input
	referenced.FileID = "published"
	if _, err := service.Initiate(ctx, referenced); err != nil {
		t.Fatal(err)
	}
	if err := service.Finalize(ctx, referenced.FileRequest, referenced.SHA256); err != nil {
		t.Fatal(err)
	}
	// This is the previous Sync release's write, without reference bookkeeping.
	exec(`insert into sync_whiteboard_elements (
		tenant_id, space_id, episode_id, scene_id, element_id, element_type,
		version, version_nonce, element_index, is_deleted, payload, encoded_bytes
	) values ($1, $2, $3, $4, 'image', 'image', 1, 1, 'a0', false, '{"fileId":"published","status":"saved"}', 39)`,
		tenant.Bytes(), space.Bytes(), episode.Bytes(), scene.Bytes())
	// Run commit checks before invoking cleanup inside the roll-back-only fixture.
	exec(`set constraints all immediate`)
	exec(`update sync_whiteboard_files set expires_at = now() - interval '30 minutes' where tenant_id = $1`, tenant.Bytes())
	if _, err := whiteboardfiles.NewCleanupWorker(repo, objects).Run(ctx); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(objects.deleted, pendingKey) || !slices.Contains(objects.deleted, key) {
		t.Fatal("cleanup should remove abandoned and unreferenced uploads, not a published image")
	}
	if _, err := service.Download(ctx, input.Subject, input.FileID); !errors.Is(err, whiteboardfiles.ErrFileNotFound) {
		t.Fatalf("orphan still readable after cleanup: %v", err)
	}
	if _, err := service.Download(ctx, referenced.Subject, referenced.FileID); err != nil {
		t.Fatalf("published image disappeared: %v", err)
	}
}

type whiteboardTestObjectStore struct {
	signed  objectstorage.CreateUploadURLInput
	data    []byte
	reads   int
	deleted []string
}

func (s *whiteboardTestObjectStore) CreateUploadURL(_ context.Context, input objectstorage.CreateUploadURLInput) (objectstorage.SignedURL, error) {
	s.signed = input
	return objectstorage.SignedURL{URL: "https://storage.test/whiteboard", ExpiresAt: time.Now().Add(input.ExpiresIn)}, nil
}

func (s *whiteboardTestObjectStore) CreateDownloadURL(_ context.Context, input objectstorage.CreateDownloadURLInput) (objectstorage.SignedURL, error) {
	return objectstorage.SignedURL{URL: "https://storage.test/whiteboard", ExpiresAt: time.Now().Add(input.ExpiresIn)}, nil
}

func (s *whiteboardTestObjectStore) GetObject(_ context.Context, key string) (objectstorage.ObjectReader, error) {
	s.reads++
	return objectstorage.ObjectReader{
		Object: objectstorage.Object{Key: key, ETag: "immutable", ContentType: "image/png", Size: int64(len(s.data))},
		Body:   io.NopCloser(bytes.NewReader(s.data)),
	}, nil
}

func (s *whiteboardTestObjectStore) DeleteObject(_ context.Context, key string) error {
	s.deleted = append(s.deleted, key)
	return nil
}
