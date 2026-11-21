package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
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
	exec(`update sync_whiteboard_files set expires_at = now() - interval '30 minutes',
		referenced_at = case when file_id = 'published' then now() end where tenant_id = $1`, tenant.Bytes())
	if _, err := whiteboardfiles.NewCleanupWorker(repo, objects).Run(ctx); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(objects.deleted, pendingKey) || !slices.Contains(objects.deleted, key) || slices.Contains(objects.deleted, objects.signed.Key) {
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
