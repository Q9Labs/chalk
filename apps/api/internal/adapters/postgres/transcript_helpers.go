package postgres

import (
	crand "crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func leaseMatches(job sqlc.ArtifactJob, attempt int, owner, token string, now time.Time) bool {
	if job.AttemptCount != int32(attempt) || !job.LeaseOwner.Valid || job.LeaseOwner.String != owner || !job.LeaseExpiresAt.Valid || !job.LeaseExpiresAt.Time.After(now) {
		return false
	}
	hash := leaseHash(token)
	return len(job.LeaseTokenHash) == len(hash) && subtle.ConstantTimeCompare(job.LeaseTokenHash, hash) == 1
}

func leaseToken() (string, error) {
	var raw [32]byte
	if _, err := crand.Read(raw[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw[:]), nil
}

func leaseHash(token string) []byte             { sum := sha256.Sum256([]byte(token)); return sum[:] }
func chunkJobKey(base string, index int) string { return fmt.Sprintf("%s-%d", base, index) }
func inputPtr(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
func stringPtr(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
func int64Value(value *int64) pgtype.Int8 {
	if value == nil {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: *value, Valid: true}
}
func nullableTextValue(value pgtype.Text) string {
	if !value.Valid {
		return ""
	}
	return value.String
}

func mapTranscript(row sqlc.Transcription) transcripts.Transcript {
	return transcripts.Transcript{ID: utilities.IDFromBytes(row.ID.Bytes), TenantID: utilities.IDFromBytes(row.TenantID.Bytes), RecordingID: utilities.IDFromBytes(row.RecordingID.Bytes), RoomID: utilities.IDFromBytes(row.RoomID.Bytes), SessionID: utilities.IDFromBytes(row.SessionID.Bytes), Status: row.Status, Provider: nullableTextValue(row.Provider), Model: nullableTextValue(row.Model), Languages: row.Languages, Metadata: jsonRaw(row.Metadata), ArtifactKey: nullableText(row.ArtifactKey), ArtifactSHA256: row.ArtifactSha256, ArtifactSize: nullableInt64Ptr(row.ArtifactSize), ArtifactContentType: nullableText(row.ArtifactContentType), SourceManifestKey: nullableText(row.SourceManifestKey), SourceManifestSHA256: row.SourceManifestSha256, SourceManifestSize: nullableInt64Ptr(row.SourceManifestSize), SourceManifestContentType: nullableText(row.SourceManifestContentType), Generation: row.Generation, CompletedAt: nullableTimestamp(row.CompletedAt), DeletedAt: nullableTimestamp(row.DeletedAt), UpdatedAt: timestamp(row.UpdatedAt), CreatedAt: timestamp(row.CreatedAt)}
}

func mapChunk(row sqlc.TranscriptChunk) transcripts.ChunkInput {
	return transcripts.ChunkInput{ID: utilities.IDFromBytes(row.ID.Bytes), Index: int(row.ChunkIndex), Generation: row.Generation, StartMS: row.StartMs, EndMS: row.EndMs, ParticipantRef: nullableTextValue(row.ParticipantRef), TrackEpoch: nullableTextValue(row.TrackEpoch), IdentityKind: row.IdentityKind, TrackClass: row.TrackClass, StorageKey: row.StorageKey, ResultKey: row.ResultKey, Checksum: row.Checksum, Size: row.Size, ContentType: row.ContentType}
}
func mapJob(row sqlc.ArtifactJob) transcripts.Job {
	return transcripts.Job{ID: utilities.IDFromBytes(row.ID.Bytes), IdempotencyKey: row.IdempotencyKey, TenantID: utilities.IDFromBytes(row.TenantID.Bytes), SessionID: nullableID(row.SessionID), RecordingID: nullableID(row.RecordingID), TranscriptID: nullableID(row.TranscriptID), ChunkID: nullableID(row.ChunkID), ArtifactKind: row.ArtifactKind, PayloadSchemaVersion: int(row.PayloadSchemaVersion), State: row.State, Priority: int(row.Priority), AvailableAt: timestamp(row.AvailableAt), Attempt: int(row.AttemptCount), AttemptLimit: int(row.AttemptLimit), LeaseOwner: nullableTextValue(row.LeaseOwner), LeaseExpiresAt: nullableTimestamp(row.LeaseExpiresAt), ErrorCode: nullableTextValue(row.ErrorCode), ErrorDetail: nullableTextValue(row.ErrorDetail), JourneyID: nullableID(row.JourneyID), Traceparent: nullableTextValue(row.Traceparent), Tracestate: nullableTextValue(row.Tracestate), TerminalAt: nullableTimestamp(row.TerminalAt), CreatedAt: timestamp(row.CreatedAt), UpdatedAt: timestamp(row.UpdatedAt)}
}
func nullableInt64Ptr(value pgtype.Int8) *int64 {
	if !value.Valid {
		return nil
	}
	return &value.Int64
}
