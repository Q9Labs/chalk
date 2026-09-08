package postgres

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

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
	chunks := make([]transcripts.ChunkInput, 0, len(rows))
	for _, row := range rows {
		chunks = append(chunks, mapSourceChunk(row))
	}
	return mapRecordingTranscriptionSource(source, chunks), nil
}

func mapRecordingTranscriptionSource(row sqlc.RecordingTranscriptionSource, chunks []transcripts.ChunkInput) transcripts.SourceInput {
	return transcripts.SourceInput{
		TenantID: utilities.IDFromBytes(row.TenantID.Bytes), RecordingID: utilities.IDFromBytes(row.RecordingID.Bytes), Generation: row.Generation,
		CommitDigest: row.CommitDigest, PresentationSHA256: row.PresentationSha256, ManifestKey: row.ManifestKey, ManifestAllocationID: utilities.IDFromBytes(row.ManifestAllocationID.Bytes),
		ManifestObjectVersion: nullableTextValue(row.ManifestObjectVersion), ManifestETag: nullableTextValue(row.ManifestEtag),
		ManifestSHA256: row.ManifestSha256, ManifestSize: row.ManifestSize, ManifestContentType: row.ManifestContentType,
		Status: row.Status, CommittedAt: timestamp(row.CommittedAt), ExpiresAt: timestamp(row.ExpiresAt), LeaseTranscriptID: nullableID(row.LeaseTranscriptID),
		LeaseExpiresAt: nullableTimestamp(row.LeaseExpiresAt), CleanupDueAt: nullableTimestamp(row.CleanupDueAt), DeletedAt: nullableTimestamp(row.DeletedAt), Chunks: chunks,
	}
}

func mapSourceChunk(row sqlc.RecordingTranscriptionSourceChunk) transcripts.ChunkInput {
	return transcripts.ChunkInput{
		ID: utilities.IDFromBytes(row.ID.Bytes), Index: int(row.ChunkIndex), Generation: row.Generation, StartMS: row.StartMs, EndMS: row.EndMs,
		SourceStartMS: row.SourceStartMs, SourceEndMS: row.SourceEndMs, ParticipantRef: nullableTextValue(row.ParticipantRef), ParticipantGeneration: nullableInt64(row.ParticipantGeneration),
		TrackID: nullableTextValue(row.TrackID), TrackEpoch: nullableTextValue(row.TrackEpoch), IdentityKind: row.IdentityKind, TrackClass: row.TrackClass,
		DisplayNameSnapshot: nullableTextValue(row.DisplayNameSnapshot), Overlap: row.Overlap, StorageKey: row.StorageKey, AllocationID: utilities.IDFromBytes(row.AllocationID.Bytes),
		ObjectVersion: nullableTextValue(row.ObjectVersion), ObjectETag: nullableTextValue(row.ObjectEtag), Checksum: row.Checksum, Size: row.Size, ContentType: row.ContentType,
	}
}
