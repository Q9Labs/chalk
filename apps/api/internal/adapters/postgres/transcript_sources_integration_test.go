package postgres

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func createTranscriptionSourceTestTables(ctx context.Context, pool *pgxpool.Conn) error {
	_, err := pool.Exec(ctx, `
create temp table recording_transcription_sources (
    recording_id uuid primary key,
    tenant_id uuid not null,
    manifest_key text not null,
    manifest_sha256 bytea not null,
    manifest_size bigint not null,
    manifest_content_type text not null,
    schema_version integer not null,
    committed_at timestamptz not null
) ;
create temp table recording_transcription_source_chunks (
    id uuid primary key,
    recording_id uuid not null,
    tenant_id uuid not null,
    chunk_index integer not null,
    generation bigint not null default 1,
    start_ms bigint not null,
    end_ms bigint not null,
    participant_ref text,
    track_epoch text,
    identity_kind text not null,
    track_class text not null,
    storage_key text not null,
    checksum bytea not null,
    size bigint not null,
    content_type text not null,
    created_at timestamptz not null default now(),
    unique (recording_id, generation, chunk_index)
) `)
	return err
}

func TestSeedSourceReplacesPriorChunkGenerations(t *testing.T) {
	databaseURL := os.Getenv("CHALK_SYNC_OVERHAUL_TEST_DATABASE_URL")
	if databaseURL == "" {
		databaseURL = os.Getenv(config.DatabaseURL)
	}
	if databaseURL == "" {
		databaseURL = config.DefaultDatabaseURL
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open source test database: %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping source test database: %v", err)
	}
	connection, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire source test connection: %v", err)
	}
	defer func() {
		_, _ = connection.Exec(ctx, "drop table if exists recording_transcription_source_chunks, recording_transcription_sources")
		connection.Release()
	}()
	if err := createTranscriptionSourceTestTables(ctx, connection); err != nil {
		t.Fatalf("create source test tables: %v", err)
	}

	tenantID, _ := utilities.NewID()
	recordingID, _ := utilities.NewID()
	repository := NewTranscriptRepositoryWithPool(sqlc.New(connection), connection)
	manifest := []byte("manifest")
	first := transcripts.SourceInput{TenantID: tenantID, RecordingID: recordingID, ManifestKey: "manifest-v1.json", ManifestSHA256: make([]byte, 32), ManifestSize: int64(len(manifest)), ManifestContentType: "application/json", Chunks: []transcripts.ChunkInput{
		sourceTestChunk(0, 1), sourceTestChunk(1, 1),
	}}
	if err := repository.SeedSource(ctx, first); err != nil {
		t.Fatalf("seed initial source: %v", err)
	}
	second := first
	second.ManifestKey = "manifest-v2.json"
	second.Chunks = []transcripts.ChunkInput{sourceTestChunk(0, 2)}
	if err := repository.SeedSource(ctx, second); err != nil {
		t.Fatalf("replace source: %v", err)
	}

	loaded, err := repository.LoadSource(ctx, tenantID, recordingID)
	if err != nil {
		t.Fatalf("load replaced source: %v", err)
	}
	if loaded.ManifestKey != second.ManifestKey || len(loaded.Chunks) != 1 || loaded.Chunks[0].Generation != 2 {
		t.Fatalf("loaded source = manifest %q chunks %#v; want only generation 2", loaded.ManifestKey, loaded.Chunks)
	}
}

func sourceTestChunk(index int, generation int64) transcripts.ChunkInput {
	id, _ := utilities.NewID()
	return transcripts.ChunkInput{ID: id, Index: index, Generation: generation, StartMS: int64(index) * 1000, EndMS: int64(index+1) * 1000, StorageKey: "chunks/source.wav", Checksum: make([]byte, 32), Size: 1, ContentType: "audio/wav"}
}
