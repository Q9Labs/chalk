package observability

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
)

type operationQuerier struct {
	sqlc.Querier
	next   sqlc.Querier
	logger *slog.Logger
}

func OperationQueries(next sqlc.Querier, logger *slog.Logger) sqlc.Querier {
	if next == nil {
		return next
	}

	return operationQuerier{
		Querier: next,
		next:    next,
		logger:  logger,
	}
}

// observe runs one query and records it as a "db.query" operation named after the query.
func observe[T any](ctx context.Context, q operationQuerier, name string, call func() (T, error)) (T, error) {
	startedAt := time.Now()
	result, err := call()
	LogOperation(ctx, q.logger, "db.query", name, startedAt, err)
	return result, err
}

func observeErr(ctx context.Context, q operationQuerier, name string, call func() error) error {
	startedAt := time.Now()
	err := call()
	LogOperation(ctx, q.logger, "db.query", name, startedAt, err)
	return err
}

func (q operationQuerier) CreateTenant(ctx context.Context, arg sqlc.CreateTenantParams) (sqlc.CreateTenantRow, error) {
	return observe(ctx, q, "CreateTenant", func() (sqlc.CreateTenantRow, error) { return q.next.CreateTenant(ctx, arg) })
}

func (q operationQuerier) GetSyncTokenSubject(ctx context.Context, arg sqlc.GetSyncTokenSubjectParams) (sqlc.GetSyncTokenSubjectRow, error) {
	return observe(ctx, q, "GetSyncTokenSubject", func() (sqlc.GetSyncTokenSubjectRow, error) { return q.next.GetSyncTokenSubject(ctx, arg) })
}

func (q operationQuerier) CreateMembership(ctx context.Context, arg sqlc.CreateMembershipParams) (sqlc.CreateMembershipRow, error) {
	return observe(ctx, q, "CreateMembership", func() (sqlc.CreateMembershipRow, error) { return q.next.CreateMembership(ctx, arg) })
}

func (q operationQuerier) CreateRecording(ctx context.Context, arg sqlc.CreateRecordingParams) (sqlc.Recording, error) {
	return observe(ctx, q, "CreateRecording", func() (sqlc.Recording, error) { return q.next.CreateRecording(ctx, arg) })
}

func (q operationQuerier) RelinquishCaptureRecordingJob(ctx context.Context, arg sqlc.RelinquishCaptureRecordingJobParams) (sqlc.RelinquishCaptureRecordingJobRow, error) {
	return observe(ctx, q, "RelinquishCaptureRecordingJob", func() (sqlc.RelinquishCaptureRecordingJobRow, error) {
		return q.next.RelinquishCaptureRecordingJob(ctx, arg)
	})
}

func (q operationQuerier) CreateSpace(ctx context.Context, arg sqlc.CreateSpaceParams) (sqlc.CreateSpaceRow, error) {
	return observe(ctx, q, "CreateSpace", func() (sqlc.CreateSpaceRow, error) { return q.next.CreateSpace(ctx, arg) })
}

func (q operationQuerier) CreateEpisode(ctx context.Context, arg sqlc.CreateEpisodeParams) (sqlc.Episode, error) {
	return observe(ctx, q, "CreateEpisode", func() (sqlc.Episode, error) { return q.next.CreateEpisode(ctx, arg) })
}

func (q operationQuerier) CreateTranscription(ctx context.Context, arg sqlc.CreateTranscriptionParams) (sqlc.Transcription, error) {
	return observe(ctx, q, "CreateTranscription", func() (sqlc.Transcription, error) { return q.next.CreateTranscription(ctx, arg) })
}

func (q operationQuerier) GetTenant(ctx context.Context, id pgtype.UUID) (sqlc.GetTenantRow, error) {
	return observe(ctx, q, "GetTenant", func() (sqlc.GetTenantRow, error) { return q.next.GetTenant(ctx, id) })
}

func (q operationQuerier) GetTenantCORSAllowedOrigins(ctx context.Context, id pgtype.UUID) ([]string, error) {
	return observe(ctx, q, "GetTenantCORSAllowedOrigins", func() ([]string, error) { return q.next.GetTenantCORSAllowedOrigins(ctx, id) })
}

func (q operationQuerier) GetTenantMembershipForUser(ctx context.Context, arg sqlc.GetTenantMembershipForUserParams) (sqlc.Membership, error) {
	return observe(ctx, q, "GetTenantMembershipForUser", func() (sqlc.Membership, error) { return q.next.GetTenantMembershipForUser(ctx, arg) })
}

func (q operationQuerier) GetTenantRecording(ctx context.Context, arg sqlc.GetTenantRecordingParams) (sqlc.Recording, error) {
	return observe(ctx, q, "GetTenantRecording", func() (sqlc.Recording, error) { return q.next.GetTenantRecording(ctx, arg) })
}

func (q operationQuerier) GetTenantSpace(ctx context.Context, arg sqlc.GetTenantSpaceParams) (sqlc.Space, error) {
	return observe(ctx, q, "GetTenantSpace", func() (sqlc.Space, error) { return q.next.GetTenantSpace(ctx, arg) })
}

func (q operationQuerier) GetTenantEpisode(ctx context.Context, arg sqlc.GetTenantEpisodeParams) (sqlc.Episode, error) {
	return observe(ctx, q, "GetTenantEpisode", func() (sqlc.Episode, error) { return q.next.GetTenantEpisode(ctx, arg) })
}

func (q operationQuerier) GetTenantTranscription(ctx context.Context, arg sqlc.GetTenantTranscriptionParams) (sqlc.Transcription, error) {
	return observe(ctx, q, "GetTenantTranscription", func() (sqlc.Transcription, error) { return q.next.GetTenantTranscription(ctx, arg) })
}

func (q operationQuerier) ListTenantMemberships(ctx context.Context, arg sqlc.ListTenantMembershipsParams) ([]sqlc.ListTenantMembershipsRow, error) {
	return observe(ctx, q, "ListTenantMemberships", func() ([]sqlc.ListTenantMembershipsRow, error) { return q.next.ListTenantMemberships(ctx, arg) })
}

func (q operationQuerier) ListTenantRecordings(ctx context.Context, arg sqlc.ListTenantRecordingsParams) ([]sqlc.Recording, error) {
	return observe(ctx, q, "ListTenantRecordings", func() ([]sqlc.Recording, error) { return q.next.ListTenantRecordings(ctx, arg) })
}

func (q operationQuerier) ListTenantSpaceRecordings(ctx context.Context, arg sqlc.ListTenantSpaceRecordingsParams) ([]sqlc.Recording, error) {
	return observe(ctx, q, "ListTenantSpaceRecordings", func() ([]sqlc.Recording, error) { return q.next.ListTenantSpaceRecordings(ctx, arg) })
}

func (q operationQuerier) ListTenantEpisodes(ctx context.Context, arg sqlc.ListTenantEpisodesParams) ([]sqlc.Episode, error) {
	return observe(ctx, q, "ListTenantEpisodes", func() ([]sqlc.Episode, error) { return q.next.ListTenantEpisodes(ctx, arg) })
}

func (q operationQuerier) ListTenantSpaces(ctx context.Context, arg sqlc.ListTenantSpacesParams) ([]sqlc.Space, error) {
	return observe(ctx, q, "ListTenantSpaces", func() ([]sqlc.Space, error) { return q.next.ListTenantSpaces(ctx, arg) })
}

func (q operationQuerier) ListTenantTranscriptions(ctx context.Context, arg sqlc.ListTenantTranscriptionsParams) ([]sqlc.Transcription, error) {
	return observe(ctx, q, "ListTenantTranscriptions", func() ([]sqlc.Transcription, error) { return q.next.ListTenantTranscriptions(ctx, arg) })
}

func (q operationQuerier) ListTenants(ctx context.Context, arg sqlc.ListTenantsParams) ([]sqlc.ListTenantsRow, error) {
	return observe(ctx, q, "ListTenants", func() ([]sqlc.ListTenantsRow, error) { return q.next.ListTenants(ctx, arg) })
}

func (q operationQuerier) UpdateTenant(ctx context.Context, id sqlc.UpdateTenantParams) (sqlc.UpdateTenantRow, error) {
	return observe(ctx, q, "UpdateTenant", func() (sqlc.UpdateTenantRow, error) { return q.next.UpdateTenant(ctx, id) })
}

func (q operationQuerier) UpdateTenantMembership(ctx context.Context, arg sqlc.UpdateTenantMembershipParams) (sqlc.UpdateTenantMembershipRow, error) {
	return observe(ctx, q, "UpdateTenantMembership", func() (sqlc.UpdateTenantMembershipRow, error) { return q.next.UpdateTenantMembership(ctx, arg) })
}

func (q operationQuerier) UpdateTenantRecording(ctx context.Context, arg sqlc.UpdateTenantRecordingParams) (sqlc.Recording, error) {
	return observe(ctx, q, "UpdateTenantRecording", func() (sqlc.Recording, error) { return q.next.UpdateTenantRecording(ctx, arg) })
}

func (q operationQuerier) UpdateTenantSpace(ctx context.Context, arg sqlc.UpdateTenantSpaceParams) (sqlc.Space, error) {
	return observe(ctx, q, "UpdateTenantSpace", func() (sqlc.Space, error) { return q.next.UpdateTenantSpace(ctx, arg) })
}

func (q operationQuerier) UpdateTenantEpisode(ctx context.Context, arg sqlc.UpdateTenantEpisodeParams) (sqlc.Episode, error) {
	return observe(ctx, q, "UpdateTenantEpisode", func() (sqlc.Episode, error) { return q.next.UpdateTenantEpisode(ctx, arg) })
}

func (q operationQuerier) UpdateTenantTranscription(ctx context.Context, arg sqlc.UpdateTenantTranscriptionParams) (sqlc.Transcription, error) {
	return observe(ctx, q, "UpdateTenantTranscription", func() (sqlc.Transcription, error) { return q.next.UpdateTenantTranscription(ctx, arg) })
}

func (q operationQuerier) AcceptTranscriptionChunkResult(ctx context.Context, arg sqlc.AcceptTranscriptionChunkResultParams) (sqlc.TranscriptionChunkResult, error) {
	return observe(ctx, q, "AcceptTranscriptionChunkResult", func() (sqlc.TranscriptionChunkResult, error) { return q.next.AcceptTranscriptionChunkResult(ctx, arg) })
}
func (q operationQuerier) CancelArtifactJob(ctx context.Context, arg sqlc.CancelArtifactJobParams) (sqlc.ArtifactJob, error) {
	return observe(ctx, q, "CancelArtifactJob", func() (sqlc.ArtifactJob, error) { return q.next.CancelArtifactJob(ctx, arg) })
}
func (q operationQuerier) ClaimArtifactJob(ctx context.Context, arg sqlc.ClaimArtifactJobParams) (sqlc.ArtifactJob, error) {
	return observe(ctx, q, "ClaimArtifactJob", func() (sqlc.ArtifactJob, error) { return q.next.ClaimArtifactJob(ctx, arg) })
}
func (q operationQuerier) CompleteArtifactJob(ctx context.Context, arg sqlc.CompleteArtifactJobParams) (sqlc.ArtifactJob, error) {
	return observe(ctx, q, "CompleteArtifactJob", func() (sqlc.ArtifactJob, error) { return q.next.CompleteArtifactJob(ctx, arg) })
}
func (q operationQuerier) CreateArtifactJob(ctx context.Context, arg sqlc.CreateArtifactJobParams) (sqlc.ArtifactJob, error) {
	return observe(ctx, q, "CreateArtifactJob", func() (sqlc.ArtifactJob, error) { return q.next.CreateArtifactJob(ctx, arg) })
}
func (q operationQuerier) CreateTranscriptionFinalizerJobIfReady(ctx context.Context, arg sqlc.CreateTranscriptionFinalizerJobIfReadyParams) (sqlc.ArtifactJob, error) {
	return observe(ctx, q, "CreateTranscriptionFinalizerJobIfReady", func() (sqlc.ArtifactJob, error) { return q.next.CreateTranscriptionFinalizerJobIfReady(ctx, arg) })
}
func (q operationQuerier) ClaimTranscriptionFinalizerJob(ctx context.Context, arg sqlc.ClaimTranscriptionFinalizerJobParams) (sqlc.ArtifactJob, error) {
	return observe(ctx, q, "ClaimTranscriptionFinalizerJob", func() (sqlc.ArtifactJob, error) { return q.next.ClaimTranscriptionFinalizerJob(ctx, arg) })
}
func (q operationQuerier) CreateRequestedTranscription(ctx context.Context, arg sqlc.CreateRequestedTranscriptionParams) (sqlc.Transcription, error) {
	return observe(ctx, q, "CreateRequestedTranscription", func() (sqlc.Transcription, error) { return q.next.CreateRequestedTranscription(ctx, arg) })
}
func (q operationQuerier) CreateTranscriptChunk(ctx context.Context, arg sqlc.CreateTranscriptChunkParams) (sqlc.TranscriptChunk, error) {
	return observe(ctx, q, "CreateTranscriptChunk", func() (sqlc.TranscriptChunk, error) { return q.next.CreateTranscriptChunk(ctx, arg) })
}
func (q operationQuerier) CreateTranscriptionAttempt(ctx context.Context, arg sqlc.CreateTranscriptionAttemptParams) (sqlc.TranscriptionAttempt, error) {
	return observe(ctx, q, "CreateTranscriptionAttempt", func() (sqlc.TranscriptionAttempt, error) { return q.next.CreateTranscriptionAttempt(ctx, arg) })
}
func (q operationQuerier) DeleteTenantTranscription(ctx context.Context, arg sqlc.DeleteTenantTranscriptionParams) (sqlc.Transcription, error) {
	return observe(ctx, q, "DeleteTenantTranscription", func() (sqlc.Transcription, error) { return q.next.DeleteTenantTranscription(ctx, arg) })
}
func (q operationQuerier) FinishTranscriptionAttempt(ctx context.Context, arg sqlc.FinishTranscriptionAttemptParams) (sqlc.TranscriptionAttempt, error) {
	return observe(ctx, q, "FinishTranscriptionAttempt", func() (sqlc.TranscriptionAttempt, error) { return q.next.FinishTranscriptionAttempt(ctx, arg) })
}
func (q operationQuerier) FinalizeTranscription(ctx context.Context, arg sqlc.FinalizeTranscriptionParams) (sqlc.Transcription, error) {
	return observe(ctx, q, "FinalizeTranscription", func() (sqlc.Transcription, error) { return q.next.FinalizeTranscription(ctx, arg) })
}
func (q operationQuerier) GetArtifactJob(ctx context.Context, id pgtype.UUID) (sqlc.ArtifactJob, error) {
	return observe(ctx, q, "GetArtifactJob", func() (sqlc.ArtifactJob, error) { return q.next.GetArtifactJob(ctx, id) })
}
func (q operationQuerier) ListTranscriptionChunkJobs(ctx context.Context, transcriptID pgtype.UUID) ([]sqlc.ArtifactJob, error) {
	return observe(ctx, q, "ListTranscriptionChunkJobs", func() ([]sqlc.ArtifactJob, error) { return q.next.ListTranscriptionChunkJobs(ctx, transcriptID) })
}
func (q operationQuerier) ListTranscriptionFinalizerJobs(ctx context.Context, transcriptID pgtype.UUID) ([]sqlc.ArtifactJob, error) {
	return observe(ctx, q, "ListTranscriptionFinalizerJobs", func() ([]sqlc.ArtifactJob, error) { return q.next.ListTranscriptionFinalizerJobs(ctx, transcriptID) })
}
func (q operationQuerier) GetArtifactJobByIdempotency(ctx context.Context, arg sqlc.GetArtifactJobByIdempotencyParams) (sqlc.ArtifactJob, error) {
	return observe(ctx, q, "GetArtifactJobByIdempotency", func() (sqlc.ArtifactJob, error) { return q.next.GetArtifactJobByIdempotency(ctx, arg) })
}
func (q operationQuerier) GetTenantTranscriptionByRecording(ctx context.Context, arg sqlc.GetTenantTranscriptionByRecordingParams) (sqlc.Transcription, error) {
	return observe(ctx, q, "GetTenantTranscriptionByRecording", func() (sqlc.Transcription, error) { return q.next.GetTenantTranscriptionByRecording(ctx, arg) })
}
func (q operationQuerier) GetTranscriptionChunkJob(ctx context.Context, transcriptID pgtype.UUID) (sqlc.ArtifactJob, error) {
	return observe(ctx, q, "GetTranscriptionChunkJob", func() (sqlc.ArtifactJob, error) { return q.next.GetTranscriptionChunkJob(ctx, transcriptID) })
}
func (q operationQuerier) GetTranscriptChunk(ctx context.Context, id pgtype.UUID) (sqlc.TranscriptChunk, error) {
	return observe(ctx, q, "GetTranscriptChunk", func() (sqlc.TranscriptChunk, error) { return q.next.GetTranscriptChunk(ctx, id) })
}
func (q operationQuerier) GetTranscriptChunkResult(ctx context.Context, arg sqlc.GetTranscriptChunkResultParams) (sqlc.TranscriptionChunkResult, error) {
	return observe(ctx, q, "GetTranscriptChunkResult", func() (sqlc.TranscriptionChunkResult, error) { return q.next.GetTranscriptChunkResult(ctx, arg) })
}
func (q operationQuerier) HeartbeatArtifactJob(ctx context.Context, arg sqlc.HeartbeatArtifactJobParams) (sqlc.ArtifactJob, error) {
	return observe(ctx, q, "HeartbeatArtifactJob", func() (sqlc.ArtifactJob, error) { return q.next.HeartbeatArtifactJob(ctx, arg) })
}
func (q operationQuerier) ListTranscriptChunks(ctx context.Context, arg sqlc.ListTranscriptChunksParams) ([]sqlc.TranscriptChunk, error) {
	return observe(ctx, q, "ListTranscriptChunks", func() ([]sqlc.TranscriptChunk, error) { return q.next.ListTranscriptChunks(ctx, arg) })
}
func (q operationQuerier) LockTenantTranscriptionForUpdate(ctx context.Context, arg sqlc.LockTenantTranscriptionForUpdateParams) (sqlc.Transcription, error) {
	return observe(ctx, q, "LockTenantTranscriptionForUpdate", func() (sqlc.Transcription, error) { return q.next.LockTenantTranscriptionForUpdate(ctx, arg) })
}
func (q operationQuerier) MarkTranscriptionTranscribing(ctx context.Context, arg sqlc.MarkTranscriptionTranscribingParams) (sqlc.Transcription, error) {
	return observe(ctx, q, "MarkTranscriptionTranscribing", func() (sqlc.Transcription, error) { return q.next.MarkTranscriptionTranscribing(ctx, arg) })
}
func (q operationQuerier) MarkTranscriptionVerifying(ctx context.Context, arg sqlc.MarkTranscriptionVerifyingParams) (sqlc.Transcription, error) {
	return observe(ctx, q, "MarkTranscriptionVerifying", func() (sqlc.Transcription, error) { return q.next.MarkTranscriptionVerifying(ctx, arg) })
}
func (q operationQuerier) RecoverExpiredArtifactJobs(ctx context.Context, arg sqlc.RecoverExpiredArtifactJobsParams) ([]sqlc.ArtifactJob, error) {
	return observe(ctx, q, "RecoverExpiredArtifactJobs", func() ([]sqlc.ArtifactJob, error) { return q.next.RecoverExpiredArtifactJobs(ctx, arg) })
}
func (q operationQuerier) RequeueArtifactJob(ctx context.Context, arg sqlc.RequeueArtifactJobParams) (sqlc.ArtifactJob, error) {
	return observe(ctx, q, "RequeueArtifactJob", func() (sqlc.ArtifactJob, error) { return q.next.RequeueArtifactJob(ctx, arg) })
}
func (q operationQuerier) RetryArtifactJob(ctx context.Context, arg sqlc.RetryArtifactJobParams) (sqlc.ArtifactJob, error) {
	return observe(ctx, q, "RetryArtifactJob", func() (sqlc.ArtifactJob, error) { return q.next.RetryArtifactJob(ctx, arg) })
}

func (q operationQuerier) GetRecordingTranscriptionSource(ctx context.Context, arg sqlc.GetRecordingTranscriptionSourceParams) (sqlc.RecordingTranscriptionSource, error) {
	return observe(ctx, q, "GetRecordingTranscriptionSource", func() (sqlc.RecordingTranscriptionSource, error) {
		return q.next.GetRecordingTranscriptionSource(ctx, arg)
	})
}
func (q operationQuerier) ListRecordingTranscriptionSourceChunks(ctx context.Context, arg sqlc.ListRecordingTranscriptionSourceChunksParams) ([]sqlc.RecordingTranscriptionSourceChunk, error) {
	return observe(ctx, q, "ListRecordingTranscriptionSourceChunks", func() ([]sqlc.RecordingTranscriptionSourceChunk, error) {
		return q.next.ListRecordingTranscriptionSourceChunks(ctx, arg)
	})
}
func (q operationQuerier) CreateTranscriptionCleanupJob(ctx context.Context, arg sqlc.CreateTranscriptionCleanupJobParams) (sqlc.TranscriptionCleanupJob, error) {
	return observe(ctx, q, "CreateTranscriptionCleanupJob", func() (sqlc.TranscriptionCleanupJob, error) { return q.next.CreateTranscriptionCleanupJob(ctx, arg) })
}
func (q operationQuerier) GetTranscriptionCleanupJob(ctx context.Context, id pgtype.UUID) (sqlc.TranscriptionCleanupJob, error) {
	return observe(ctx, q, "GetTranscriptionCleanupJob", func() (sqlc.TranscriptionCleanupJob, error) { return q.next.GetTranscriptionCleanupJob(ctx, id) })
}
func (q operationQuerier) ClaimTranscriptionCleanupJob(ctx context.Context, arg sqlc.ClaimTranscriptionCleanupJobParams) (sqlc.TranscriptionCleanupJob, error) {
	return observe(ctx, q, "ClaimTranscriptionCleanupJob", func() (sqlc.TranscriptionCleanupJob, error) { return q.next.ClaimTranscriptionCleanupJob(ctx, arg) })
}
func (q operationQuerier) CompleteTranscriptionCleanupJob(ctx context.Context, arg sqlc.CompleteTranscriptionCleanupJobParams) (sqlc.TranscriptionCleanupJob, error) {
	return observe(ctx, q, "CompleteTranscriptionCleanupJob", func() (sqlc.TranscriptionCleanupJob, error) { return q.next.CompleteTranscriptionCleanupJob(ctx, arg) })
}
func (q operationQuerier) RetryTranscriptionCleanupJob(ctx context.Context, arg sqlc.RetryTranscriptionCleanupJobParams) (sqlc.TranscriptionCleanupJob, error) {
	return observe(ctx, q, "RetryTranscriptionCleanupJob", func() (sqlc.TranscriptionCleanupJob, error) { return q.next.RetryTranscriptionCleanupJob(ctx, arg) })
}
func (q operationQuerier) RecoverExpiredTranscriptionCleanupJobs(ctx context.Context, arg sqlc.RecoverExpiredTranscriptionCleanupJobsParams) ([]sqlc.TranscriptionCleanupJob, error) {
	return observe(ctx, q, "RecoverExpiredTranscriptionCleanupJobs", func() ([]sqlc.TranscriptionCleanupJob, error) {
		return q.next.RecoverExpiredTranscriptionCleanupJobs(ctx, arg)
	})
}

var _ sqlc.Querier = operationQuerier{}

func (q operationQuerier) FindServiceTenantID(ctx context.Context, arg sqlc.FindServiceTenantIDParams) (pgtype.UUID, error) {
	return observe(ctx, q, "FindServiceTenantID", func() (pgtype.UUID, error) { return q.next.FindServiceTenantID(ctx, arg) })
}
