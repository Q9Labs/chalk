package postgres

import (
	"context"
	"crypto/sha256"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r TranscriptRepository) SeedSource(ctx context.Context, input transcripts.SourceInput) error {
	if r.transactor == nil {
		return transcripts.ErrArtifactRepository
	}
	if input.ManifestContentType != "application/json" || len(input.ManifestSHA256) != sha256.Size || input.ManifestSize < 1 || input.ManifestSize > 524288000 {
		return transcripts.ErrInvalidManifest
	}
	tx, err := r.transactor.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := sqlc.New(tx)
	if _, err := q.UpsertRecordingTranscriptionSource(ctx, sqlc.UpsertRecordingTranscriptionSourceParams{RecordingID: uuid(input.RecordingID), TenantID: uuid(input.TenantID), ManifestKey: input.ManifestKey, ManifestSha256: input.ManifestSHA256, ManifestSize: input.ManifestSize, ManifestContentType: input.ManifestContentType, SchemaVersion: 1, CommittedAt: pgtype.Timestamptz{Time: time.Now(), Valid: true}}); err != nil {
		return err
	}
	for _, chunk := range input.Chunks {
		if chunk.IdentityKind == "" {
			chunk.IdentityKind = "unknown"
		}
		if chunk.TrackClass == "" {
			chunk.TrackClass = "unknown"
		}
		if chunk.ID.IsZero() {
			generated, err := utilities.NewID()
			if err != nil {
				return err
			}
			chunk.ID = generated
		}
		if _, err := q.ReplaceRecordingTranscriptionSourceChunk(ctx, sqlc.ReplaceRecordingTranscriptionSourceChunkParams{ID: uuid(chunk.ID), RecordingID: uuid(input.RecordingID), TenantID: uuid(input.TenantID), ChunkIndex: int32(chunk.Index), Generation: chunk.Generation, StartMs: chunk.StartMS, EndMs: chunk.EndMS, ParticipantRef: text(stringPtr(chunk.ParticipantRef)), TrackEpoch: text(stringPtr(chunk.TrackEpoch)), IdentityKind: chunk.IdentityKind, TrackClass: chunk.TrackClass, StorageKey: chunk.StorageKey, Checksum: chunk.Checksum, Size: chunk.Size, ContentType: chunk.ContentType}); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (r TranscriptRepository) LoadSource(ctx context.Context, tenantID, recordingID utilities.ID) (transcripts.SourceInput, error) {
	q, ok := r.queries.(transcriptSourceQuerier)
	if !ok {
		return transcripts.SourceInput{}, transcripts.ErrArtifactRepository
	}
	source, err := q.GetRecordingTranscriptionSource(ctx, sqlc.GetRecordingTranscriptionSourceParams{RecordingID: uuid(recordingID), TenantID: uuid(tenantID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return transcripts.SourceInput{}, transcripts.ErrSourceNotReady
	}
	if err != nil {
		return transcripts.SourceInput{}, err
	}
	rows, err := q.ListRecordingTranscriptionSourceChunks(ctx, sqlc.ListRecordingTranscriptionSourceChunksParams{RecordingID: uuid(recordingID), TenantID: uuid(tenantID)})
	if err != nil {
		return transcripts.SourceInput{}, err
	}
	if len(rows) == 0 {
		return transcripts.SourceInput{}, transcripts.ErrSourceNotReady
	}
	input := transcripts.SourceInput{TenantID: tenantID, RecordingID: recordingID, ManifestKey: source.ManifestKey, ManifestSHA256: source.ManifestSha256, ManifestSize: source.ManifestSize, ManifestContentType: source.ManifestContentType, Chunks: make([]transcripts.ChunkInput, 0, len(rows))}
	for _, row := range rows {
		input.Chunks = append(input.Chunks, transcripts.ChunkInput{ID: utilities.IDFromBytes(row.ID.Bytes), Index: int(row.ChunkIndex), Generation: row.Generation, StartMS: row.StartMs, EndMS: row.EndMs, ParticipantRef: nullableTextValue(row.ParticipantRef), TrackEpoch: nullableTextValue(row.TrackEpoch), IdentityKind: row.IdentityKind, TrackClass: row.TrackClass, StorageKey: row.StorageKey, Checksum: row.Checksum, Size: row.Size, ContentType: row.ContentType})
	}
	return input, nil
}
