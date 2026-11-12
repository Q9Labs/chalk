package postgres

import (
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func mapGetPipeline(row sqlc.GetRecordingPipelineRow) recordingpipeline.Pipeline {
	var stopOperationID *utilities.ID
	if row.StopOperationID.Valid {
		id := utilities.IDFromBytes(row.StopOperationID.Bytes)
		stopOperationID = &id
	}
	return recordingpipeline.Pipeline{
		RecordingID:        utilities.IDFromBytes(row.RecordingID.Bytes),
		TenantID:           utilities.IDFromBytes(row.TenantID.Bytes),
		ReservationID:      utilities.IDFromBytes(row.ReservationID.Bytes),
		State:              recordingpipeline.State(row.State),
		CaptureEpoch:       row.CaptureEpoch,
		StopOperationID:    stopOperationID,
		StopRequestedAt:    nullableTimestamp(row.StopRequestedAt),
		CaptureCompletedAt: nullableTimestamp(row.CaptureCompletedAt),
		CommittedAt:        nullableTimestamp(row.CommittedAt),
		UpdatedAt:          timestamp(row.UpdatedAt),
		CreatedAt:          timestamp(row.CreatedAt),
	}
}

func mapRequestRecordingStop(row sqlc.RequestRecordingStopRow) recordingpipeline.Pipeline {
	var stopOperationID *utilities.ID
	if row.StopOperationID.Valid {
		id := utilities.IDFromBytes(row.StopOperationID.Bytes)
		stopOperationID = &id
	}
	return recordingpipeline.Pipeline{
		RecordingID:        utilities.IDFromBytes(row.RecordingID.Bytes),
		TenantID:           utilities.IDFromBytes(row.TenantID.Bytes),
		ReservationID:      utilities.IDFromBytes(row.ReservationID.Bytes),
		State:              recordingpipeline.State(row.State),
		CaptureEpoch:       row.CaptureEpoch,
		StopOperationID:    stopOperationID,
		StopRequestedAt:    nullableTimestamp(row.StopRequestedAt),
		CaptureCompletedAt: nullableTimestamp(row.CaptureCompletedAt),
		CommittedAt:        nullableTimestamp(row.CommittedAt),
		UpdatedAt:          timestamp(row.UpdatedAt),
		CreatedAt:          timestamp(row.CreatedAt),
	}
}

func mapRecordingJob(row sqlc.RecordingJob) recordingpipeline.Job {
	return recordingpipeline.Job{
		ID:                   utilities.IDFromBytes(row.ID.Bytes),
		TenantID:             utilities.IDFromBytes(row.TenantID.Bytes),
		EpisodeID:            utilities.IDFromBytes(row.EpisodeID.Bytes),
		RecordingID:          utilities.IDFromBytes(row.RecordingID.Bytes),
		Kind:                 recordingpipeline.JobKind(row.Kind),
		IdempotencyKey:       row.IdempotencyKey,
		PayloadSchemaVersion: int(row.PayloadSchemaVersion),
		State:                recordingpipeline.JobState(row.State),
		Priority:             int(row.Priority),
		AvailableAt:          timestamp(row.AvailableAt),
		AttemptCount:         int(row.AttemptCount),
		AttemptLimit:         int(row.AttemptLimit),
		LeaseToken:           nullableTextPointer(row.LeaseToken),
		LeaseOwner:           nullableTextPointer(row.LeaseOwner),
		LeaseExpiresAt:       nullableTimestamp(row.LeaseExpiresAt),
		FencingGeneration:    row.FencingGeneration,
		ErrorCode:            nullableTextPointer(row.ErrorCode),
		ErrorDetail:          nullableTextPointer(row.ErrorDetail),
		TerminalAt:           nullableTimestamp(row.TerminalAt),
		UpdatedAt:            timestamp(row.UpdatedAt),
		CreatedAt:            timestamp(row.CreatedAt),
	}
}

func mapDeferredRecordingJob(row sqlc.RequestDeferredRecordingRenderRow) recordingpipeline.Job {
	return recordingpipeline.Job{
		ID:                   utilities.IDFromBytes(row.ID.Bytes),
		TenantID:             utilities.IDFromBytes(row.TenantID.Bytes),
		EpisodeID:            utilities.IDFromBytes(row.EpisodeID.Bytes),
		RecordingID:          utilities.IDFromBytes(row.RecordingID.Bytes),
		Kind:                 recordingpipeline.JobKind(row.Kind),
		IdempotencyKey:       row.IdempotencyKey,
		PayloadSchemaVersion: int(row.PayloadSchemaVersion),
		State:                recordingpipeline.JobState(row.State),
		Priority:             int(row.Priority),
		AvailableAt:          timestamp(row.AvailableAt),
		AttemptCount:         int(row.AttemptCount),
		AttemptLimit:         int(row.AttemptLimit),
		LeaseToken:           nullableTextPointer(row.LeaseToken),
		LeaseOwner:           nullableTextPointer(row.LeaseOwner),
		LeaseExpiresAt:       nullableTimestamp(row.LeaseExpiresAt),
		FencingGeneration:    row.FencingGeneration,
		ErrorCode:            nullableTextPointer(row.ErrorCode),
		ErrorDetail:          nullableTextPointer(row.ErrorDetail),
		TerminalAt:           nullableTimestamp(row.TerminalAt),
		UpdatedAt:            timestamp(row.UpdatedAt),
		CreatedAt:            timestamp(row.CreatedAt),
	}
}

func mapClaimJob(row sqlc.ClaimRecordingJobRow) recordingpipeline.Job {
	return recordingpipeline.Job{
		ID:                   utilities.IDFromBytes(row.ID.Bytes),
		TenantID:             utilities.IDFromBytes(row.TenantID.Bytes),
		EpisodeID:            utilities.IDFromBytes(row.EpisodeID.Bytes),
		RecordingID:          utilities.IDFromBytes(row.RecordingID.Bytes),
		Kind:                 recordingpipeline.JobKind(row.Kind),
		IdempotencyKey:       row.IdempotencyKey,
		PayloadSchemaVersion: int(row.PayloadSchemaVersion),
		State:                recordingpipeline.JobState(row.State),
		Priority:             int(row.Priority),
		AvailableAt:          timestamp(row.AvailableAt),
		AttemptCount:         int(row.AttemptCount),
		AttemptLimit:         int(row.AttemptLimit),
		LeaseToken:           nullableTextPointer(row.LeaseToken),
		LeaseOwner:           nullableTextPointer(row.LeaseOwner),
		LeaseExpiresAt:       nullableTimestamp(row.LeaseExpiresAt),
		FencingGeneration:    row.FencingGeneration,
		CaptureEpoch:         row.CaptureEpoch,
		CompletionOnly:       row.CompletionOnly,
		ErrorCode:            nullableTextPointer(row.ErrorCode),
		ErrorDetail:          nullableTextPointer(row.ErrorDetail),
		TerminalAt:           nullableTimestamp(row.TerminalAt),
		UpdatedAt:            timestamp(row.UpdatedAt),
		CreatedAt:            timestamp(row.CreatedAt),
	}
}

func mapAuthorityJob(row sqlc.GetRecordingJobAttemptAuthorityByClaimRequestRow) (recordingpipeline.Job, error) {
	job := recordingpipeline.Job{
		ID:                   utilities.IDFromBytes(row.JobID.Bytes),
		TenantID:             utilities.IDFromBytes(row.TenantID.Bytes),
		EpisodeID:            utilities.IDFromBytes(row.EpisodeID.Bytes),
		RecordingID:          utilities.IDFromBytes(row.RecordingID.Bytes),
		Kind:                 recordingpipeline.JobKind(row.Kind),
		IdempotencyKey:       row.IdempotencyKey,
		PayloadSchemaVersion: int(row.PayloadSchemaVersion),
		State:                recordingpipeline.JobState(row.State),
		Priority:             int(row.Priority),
		AvailableAt:          timestamp(row.AvailableAt),
		AttemptCount:         int(row.AttemptCount),
		AttemptLimit:         int(row.AttemptLimit),
		FencingGeneration:    row.FencingGeneration,
		CaptureEpoch:         row.CaptureEpoch,
		ErrorCode:            nullableTextPointer(row.ErrorCode),
		ErrorDetail:          nullableTextPointer(row.ErrorDetail),
		TerminalAt:           nullableTimestamp(row.TerminalAt),
		UpdatedAt:            timestamp(row.UpdatedAt),
		CreatedAt:            timestamp(row.CreatedAt),
	}
	leaseToken := row.LeaseToken
	leaseOwner := row.LeaseOwner
	leaseExpiresAt := timestamp(row.LeaseExpiresAt)
	job.LeaseToken = &leaseToken
	job.LeaseOwner = &leaseOwner
	job.LeaseExpiresAt = &leaseExpiresAt
	envelope, err := recordingpipeline.DecodeRecorderJobEnvelope(row.EnvelopeBytes, row.EnvelopeDigest)
	if err != nil {
		return recordingpipeline.Job{}, err
	}
	job.CompletionOnly = envelope.CompletionOnly
	hardDeadline, err := recordingJobDeadline(job.Kind, row.EndsAt, row.ExecutionStartedAt)
	if err != nil {
		return recordingpipeline.Job{}, err
	}
	if envelope.JobID != job.ID.String() || envelope.TenantID != job.TenantID.String() || envelope.EpisodeID != job.EpisodeID.String() || envelope.RecordingID != job.RecordingID.String() || envelope.Kind != job.Kind || envelope.AttemptCount != job.AttemptCount || envelope.FencingGeneration != job.FencingGeneration || envelope.CaptureEpoch != job.CaptureEpoch || envelope.SpaceID != utilities.IDFromBytes(row.SpaceID.Bytes).String() || envelope.PolicySnapshotVersion != row.PolicySnapshotVersion || envelope.HardDeadline != hardDeadline.UTC().Format(time.RFC3339Nano) {
		return recordingpipeline.Job{}, recordingpipeline.ErrInvalidEnvelope
	}
	job.Authority = &recordingpipeline.JobAuthority{
		ClaimRequestID: utilities.IDFromBytes(row.ClaimRequestID.Bytes),
		Envelope:       envelope,
		EnvelopeBytes:  append([]byte(nil), row.EnvelopeBytes...),
		EnvelopeDigest: append([]byte(nil), row.EnvelopeDigest...),
		LeaseOwner:     row.LeaseOwner,
		LeaseToken:     row.LeaseToken,
		LeaseExpiresAt: leaseExpiresAt,
		IssuedAt:       timestamp(row.IssuedAt),
	}
	return job, nil
}

func recordingJobDeadline(kind recordingpipeline.JobKind, captureDeadline, jobCreatedAt pgtype.Timestamptz) (time.Time, error) {
	if kind == recordingpipeline.JobKindCapture {
		return timestamp(captureDeadline), nil
	}
	if !jobCreatedAt.Valid {
		return time.Time{}, recordingpipeline.ErrInvalidEnvelope
	}
	return timestamp(jobCreatedAt).Add(recordingpipeline.MaximumRenderDuration), nil
}

func mapFailJob(row sqlc.FailRecordingJobRow) recordingpipeline.Job {
	return recordingpipeline.Job{
		ID:                   utilities.IDFromBytes(row.ID.Bytes),
		TenantID:             utilities.IDFromBytes(row.TenantID.Bytes),
		EpisodeID:            utilities.IDFromBytes(row.EpisodeID.Bytes),
		RecordingID:          utilities.IDFromBytes(row.RecordingID.Bytes),
		Kind:                 recordingpipeline.JobKind(row.Kind),
		IdempotencyKey:       row.IdempotencyKey,
		PayloadSchemaVersion: int(row.PayloadSchemaVersion),
		State:                recordingpipeline.JobState(row.State),
		Priority:             int(row.Priority),
		AvailableAt:          timestamp(row.AvailableAt),
		AttemptCount:         int(row.AttemptCount),
		AttemptLimit:         int(row.AttemptLimit),
		LeaseToken:           nullableTextPointer(row.LeaseToken),
		LeaseOwner:           nullableTextPointer(row.LeaseOwner),
		LeaseExpiresAt:       nullableTimestamp(row.LeaseExpiresAt),
		FencingGeneration:    row.FencingGeneration,
		ErrorCode:            nullableTextPointer(row.ErrorCode),
		ErrorDetail:          nullableTextPointer(row.ErrorDetail),
		TerminalAt:           nullableTimestamp(row.TerminalAt),
		UpdatedAt:            timestamp(row.UpdatedAt),
		CreatedAt:            timestamp(row.CreatedAt),
	}
}

func mapRelinquishedCaptureJob(row sqlc.RelinquishCaptureRecordingJobRow) recordingpipeline.Job {
	return recordingpipeline.Job{
		ID:                   utilities.IDFromBytes(row.ID.Bytes),
		TenantID:             utilities.IDFromBytes(row.TenantID.Bytes),
		EpisodeID:            utilities.IDFromBytes(row.EpisodeID.Bytes),
		RecordingID:          utilities.IDFromBytes(row.RecordingID.Bytes),
		Kind:                 recordingpipeline.JobKind(row.Kind),
		IdempotencyKey:       row.IdempotencyKey,
		PayloadSchemaVersion: int(row.PayloadSchemaVersion),
		State:                recordingpipeline.JobState(row.State),
		Priority:             int(row.Priority),
		AvailableAt:          timestamp(row.AvailableAt),
		AttemptCount:         int(row.AttemptCount),
		AttemptLimit:         int(row.AttemptLimit),
		LeaseToken:           nullableTextPointer(row.LeaseToken),
		LeaseOwner:           nullableTextPointer(row.LeaseOwner),
		LeaseExpiresAt:       nullableTimestamp(row.LeaseExpiresAt),
		FencingGeneration:    row.FencingGeneration,
		ErrorCode:            nullableTextPointer(row.ErrorCode),
		ErrorDetail:          nullableTextPointer(row.ErrorDetail),
		TerminalAt:           nullableTimestamp(row.TerminalAt),
		UpdatedAt:            timestamp(row.UpdatedAt),
		CreatedAt:            timestamp(row.CreatedAt),
	}
}

func mapRecoveredJob(row sqlc.RecoverExpiredRecordingJobsRow) recordingpipeline.Job {
	return recordingpipeline.Job{
		ID:                   utilities.IDFromBytes(row.ID.Bytes),
		TenantID:             utilities.IDFromBytes(row.TenantID.Bytes),
		EpisodeID:            utilities.IDFromBytes(row.EpisodeID.Bytes),
		RecordingID:          utilities.IDFromBytes(row.RecordingID.Bytes),
		Kind:                 recordingpipeline.JobKind(row.Kind),
		IdempotencyKey:       row.IdempotencyKey,
		PayloadSchemaVersion: int(row.PayloadSchemaVersion),
		State:                recordingpipeline.JobState(row.State),
		Priority:             int(row.Priority),
		AvailableAt:          timestamp(row.AvailableAt),
		AttemptCount:         int(row.AttemptCount),
		AttemptLimit:         int(row.AttemptLimit),
		LeaseToken:           nullableTextPointer(row.LeaseToken),
		LeaseOwner:           nullableTextPointer(row.LeaseOwner),
		LeaseExpiresAt:       nullableTimestamp(row.LeaseExpiresAt),
		FencingGeneration:    row.FencingGeneration,
		ErrorCode:            nullableTextPointer(row.ErrorCode),
		ErrorDetail:          nullableTextPointer(row.ErrorDetail),
		TerminalAt:           nullableTimestamp(row.TerminalAt),
		UpdatedAt:            timestamp(row.UpdatedAt),
		CreatedAt:            timestamp(row.CreatedAt),
	}
}

func mapJobs(rows []sqlc.RecordingJob) []recordingpipeline.Job {
	jobs := make([]recordingpipeline.Job, 0, len(rows))
	for _, row := range rows {
		jobs = append(jobs, mapRecordingJob(row))
	}
	return jobs
}
