package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r RecordingPipelineRepository) GetPipeline(ctx context.Context, tenantID, recordingID utilities.ID) (recordingpipeline.Pipeline, error) {
	row, err := r.queries.GetRecordingPipeline(ctx, sqlc.GetRecordingPipelineParams{TenantID: uuid(tenantID), RecordingID: uuid(recordingID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.Pipeline{}, recordingpipeline.ErrPipelineNotFound
	}
	if err != nil {
		return recordingpipeline.Pipeline{}, fmt.Errorf("get recording pipeline: %w", err)
	}
	return mapGetPipeline(row), nil
}

func (r RecordingPipelineRepository) RequestStop(ctx context.Context, tenantID, episodeID, recordingID, operationID utilities.ID) (recordingpipeline.Pipeline, error) {
	row, err := r.queries.RequestRecordingStop(ctx, sqlc.RequestRecordingStopParams{
		TenantID: uuid(tenantID), EpisodeID: uuid(episodeID), RecordingID: uuid(recordingID), StopOperationID: uuid(operationID),
	})
	if err == nil {
		return mapRequestRecordingStop(row), nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.Pipeline{}, fmt.Errorf("request recording stop: %w", err)
	}

	existing, getErr := r.queries.GetRecordingPipelineStopAuthority(ctx, sqlc.GetRecordingPipelineStopAuthorityParams{
		TenantID: uuid(tenantID), EpisodeID: uuid(episodeID), RecordingID: uuid(recordingID),
	})
	if errors.Is(getErr, pgx.ErrNoRows) {
		return recordingpipeline.Pipeline{}, recordingpipeline.ErrPipelineNotFound
	}
	if getErr != nil {
		return recordingpipeline.Pipeline{}, fmt.Errorf("resolve recording stop: %w", getErr)
	}
	if existing.StopOperationID.Valid && existing.StopOperationID.Bytes != operationID.Bytes() {
		return recordingpipeline.Pipeline{}, recordingpipeline.ErrStopConflict
	}
	return recordingpipeline.Pipeline{}, recordingpipeline.ErrInvalidStateTransition
}

func (r RecordingPipelineRepository) Claim(ctx context.Context, input recordingpipeline.ClaimInput) (recordingpipeline.Job, error) {
	if input.ClaimRequestID.IsZero() || input.LeaseFor <= 0 || input.LeaseToken == "" || input.Owner == "" {
		return recordingpipeline.Job{}, recordingpipeline.ErrInvalidLease
	}
	if r.queries != nil {
		if replay, err := getClaimReplay(ctx, r.queries, input); err == nil {
			return replay, nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return recordingpipeline.Job{}, err
		}
	}
	if r.transactor == nil {
		return recordingpipeline.Job{}, errors.New("recording claim transaction is unavailable")
	}
	var claimed recordingpipeline.Job
	issuedAt := r.now().UTC()
	leaseExpiresAt := issuedAt.Add(input.LeaseFor)
	err := r.transaction(ctx, func(tx pgx.Tx, queries recordingPipelineQuerier) error {
		if err := queries.LockRecordingJobClaimRequest(ctx, input.ClaimRequestID.String()); err != nil {
			return fmt.Errorf("lock recording claim request: %w", err)
		}
		if replay, err := getClaimReplay(ctx, queries, input); err == nil {
			claimed = replay
			return nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		// Admission closure updates this row, so it cannot overtake an in-flight claim.
		role := string(input.Kind)
		if input.Kind == recordingpipeline.JobKindTranscription {
			role = string(recordingpipeline.PoolRoleRender)
		}
		authorized, err := queries.LockRecordingFleetWorkerClaim(ctx, sqlc.LockRecordingFleetWorkerClaimParams{
			Role: role, LeaseOwner: input.Owner, ColocatedEnabled: r.colocatedGrace > 0,
		})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("lock recording worker admission: %w", err)
		}
		// Authentication can precede row loss. Managed claims must still have
		// an admitted binding here, in the transaction that creates the lease.
		if errors.Is(err, pgx.ErrNoRows) && input.ManagedWorker || err == nil && !authorized {
			return recordingpipeline.ErrJobNotFound
		}
		row, err := queries.ClaimRecordingJob(ctx, sqlc.ClaimRecordingJobParams{
			TranscriptionEnabled:   r.transcriptionEnabled,
			SupportsCompletionOnly: input.SupportsCompletionOnly,
			MaximumRenderSeconds:   int32(recordingpipeline.MaximumRenderDuration / time.Second),
			LeaseToken:             requiredTextValue(input.LeaseToken),
			LeaseOwner:             input.Owner,
			LeaseExpiresAt:         timestamptzValue(leaseExpiresAt),
			Kind:                   string(input.Kind),
			ColocatedGraceSeconds:  colocatedGraceSeconds(r.colocatedGrace),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return recordingpipeline.ErrJobNotFound
		}
		if err != nil {
			return fmt.Errorf("claim recording job: %w", err)
		}
		claimed = mapClaimJob(row)
		leaseExpiresAt = timestamp(row.LeaseExpiresAt)
		claimed.CaptureEpoch = row.CaptureEpoch
		claimed.CompletionOnly = row.CompletionOnly
		hardDeadline, err := recordingJobDeadline(claimed.Kind, row.EndsAt, row.ExecutionStartedAt)
		if err != nil {
			return err
		}
		claimFacts := recordingpipeline.ClaimFacts{
			SpaceID: utilities.IDFromBytes(row.SpaceID.Bytes), PolicySnapshotVersion: row.PolicySnapshotVersion,
			HardDeadline: hardDeadline, CaptureEpoch: row.CaptureEpoch, CaptureReadyAt: nullableTimestamp(row.CaptureReadyAt), CompletionOnly: row.CompletionOnly,
		}
		if claimed.Kind == recordingpipeline.JobKindCapture {
			claimFacts.BundleSchemaVersion = captureBundleSchemaVersion(r.recordingBundleV2Enabled, nil)
			previous, previousErr := queries.GetRecordingCaptureJobEnvelope(ctx, uuid(claimed.ID))
			if previousErr == nil {
				previousEnvelope, decodeErr := recordingpipeline.DecodeRecorderJobEnvelope(previous.EnvelopeBytes, previous.EnvelopeDigest)
				if decodeErr != nil || previousEnvelope.Kind != recordingpipeline.JobKindCapture || previousEnvelope.JobID != claimed.ID.String() {
					return recordingpipeline.ErrInvalidEnvelope
				}
				claimFacts.BundleSchemaVersion = captureBundleSchemaVersion(r.recordingBundleV2Enabled, &previousEnvelope)
			} else if !errors.Is(previousErr, pgx.ErrNoRows) {
				return fmt.Errorf("load original capture bundle schema: %w", previousErr)
			}
		}
		if claimed.Kind == recordingpipeline.JobKindRender || claimed.Kind == recordingpipeline.JobKindTranscription {
			claimFacts.CaptureKeyHandle = utilities.IDFromBytes(row.CaptureKeyHandle.Bytes)
			claimFacts.PresentationHandle = utilities.IDFromBytes(row.PresentationHandle.Bytes)
			claimFacts.PresentationSchemaVersion = row.PresentationSchemaVersion.String
			claimFacts.PresentationProfileVersion = row.PresentationProfileVersion.String
			claimFacts.PresentationSHA256 = append([]byte(nil), row.PresentationSha256...)
			claimFacts.PresentationDurationMillis = row.PresentationDurationMillis.Int64
		}
		authority, err := recordingpipeline.NewRecorderJobAuthority(claimed, claimFacts, input.ClaimRequestID, issuedAt)
		if err != nil {
			return err
		}
		authority.LeaseOwner = input.Owner
		authority.LeaseToken = input.LeaseToken
		authority.LeaseExpiresAt = leaseExpiresAt
		if _, err := queries.InsertRecordingJobAttemptAuthority(ctx, sqlc.InsertRecordingJobAttemptAuthorityParams{
			JobID: uuid(claimed.ID), AttemptCount: int32(claimed.AttemptCount),
			FencingGeneration: claimed.FencingGeneration, CaptureEpoch: row.CaptureEpoch,
			ClaimRequestID: uuid(input.ClaimRequestID), Kind: string(claimed.Kind),
			LeaseOwner: input.Owner, LeaseToken: input.LeaseToken,
			LeaseExpiresAt: timestamptzValue(leaseExpiresAt), EnvelopeBytes: authority.EnvelopeBytes,
			EnvelopeDigest: authority.EnvelopeDigest, IssuedAt: timestamptzValue(issuedAt),
		}); err != nil {
			return err
		}
		if claimed.Kind == recordingpipeline.JobKindRender || claimed.Kind == recordingpipeline.JobKindTranscription {
			renderInputHandle, parseInputErr := utilities.ParseID(authority.Envelope.RenderInputHandle)
			objectHandle, parseObjectErr := utilities.ParseID(authority.Envelope.ObjectHandle)
			if parseInputErr != nil || parseObjectErr != nil {
				return recordingpipeline.ErrInvalidEnvelope
			}
			if _, err := queries.InsertRecordingRenderInput(ctx, sqlc.InsertRecordingRenderInputParams{
				RenderInputHandle: uuid(renderInputHandle), TenantID: uuid(claimed.TenantID), SpaceID: uuid(claimFacts.SpaceID),
				EpisodeID: uuid(claimed.EpisodeID), RecordingID: uuid(claimed.RecordingID), RenderJobID: uuid(claimed.ID),
				AttemptCount: int32(claimed.AttemptCount), FencingGeneration: claimed.FencingGeneration,
				CaptureEpoch: row.CaptureEpoch, EnvelopeDigest: authority.EnvelopeDigest,
				KeyHandle: uuid(claimFacts.CaptureKeyHandle), ObjectHandle: uuid(objectHandle),
				PresentationHandle: uuid(claimFacts.PresentationHandle), PresentationSchemaVersion: claimFacts.PresentationSchemaVersion,
				PresentationProfileVersion: claimFacts.PresentationProfileVersion, PresentationSha256: claimFacts.PresentationSHA256,
				PresentationDurationMillis: claimFacts.PresentationDurationMillis, CaptureReadyAt: row.CaptureReadyAt,
				LeaseToken: requiredTextValue(input.LeaseToken), LeaseOwner: requiredTextValue(input.Owner), LeaseExpiresAt: timestamptzValue(leaseExpiresAt),
			}); err != nil {
				return fmt.Errorf("persist recording render input authority: %w", err)
			}
		}
		if claimed.Kind == recordingpipeline.JobKindCapture {
			traceID, spanID, _, _ := lifecycleTraceContext(ctx)
			if err := queries.InsertRecordingClaimedEvent(ctx, sqlc.InsertRecordingClaimedEventParams{
				JobID: uuid(claimed.ID), LeaseOwner: input.Owner, TraceID: optionalText(traceID), SpanID: optionalText(spanID),
			}); err != nil {
				return fmt.Errorf("record recording claim: %w", err)
			}
		}
		claimed.Authority = &authority
		return nil
	})
	if err == nil {
		return claimed, nil
	}
	if r.queries != nil && (uniqueConstraintViolation(err, "recording_job_attempt_authorities_claim_request_id_key") || errors.Is(err, recordingpipeline.ErrJobNotFound)) {
		if replay, replayErr := getClaimReplay(ctx, r.queries, input); replayErr == nil {
			return replay, nil
		} else if !errors.Is(replayErr, pgx.ErrNoRows) {
			return recordingpipeline.Job{}, replayErr
		}
	}
	return recordingpipeline.Job{}, err
}

func getClaimReplay(ctx context.Context, queries recordingPipelineQuerier, input recordingpipeline.ClaimInput) (recordingpipeline.Job, error) {
	row, err := queries.GetRecordingJobAttemptAuthorityByClaimRequest(ctx, uuid(input.ClaimRequestID))
	if err != nil {
		return recordingpipeline.Job{}, err
	}
	if row.Kind != string(input.Kind) || row.LeaseOwner != input.Owner {
		return recordingpipeline.Job{}, recordingpipeline.ErrClaimConflict
	}
	return mapAuthorityJob(row)
}

func (r RecordingPipelineRepository) ListDeadLetters(ctx context.Context, tenantID utilities.ID, limit int) ([]recordingpipeline.Job, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	rows, err := r.queries.ListRecordingDeadLetters(ctx, sqlc.ListRecordingDeadLettersParams{TenantID: uuid(tenantID), LimitCount: int32(limit)})
	if err != nil {
		return nil, fmt.Errorf("list recording dead letters: %w", err)
	}
	return mapJobs(rows), nil
}

func (r RecordingPipelineRepository) ListForReconciliation(ctx context.Context, query recordingpipeline.ReconciliationQuery) ([]recordingpipeline.Job, error) {
	limit := query.Limit
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	rows, err := r.queries.ListRecordingJobsForReconciliation(ctx, sqlc.ListRecordingJobsForReconciliationParams{
		StaleBefore:    timestamptzValue(query.StaleBefore),
		TerminalBefore: timestamptzValue(query.TerminalBefore),
		LimitCount:     int32(limit),
	})
	if err != nil {
		return nil, fmt.Errorf("list recording jobs for reconciliation: %w", err)
	}
	return mapJobs(rows), nil
}

func (r RecordingPipelineRepository) ListHeldCaptureSlots(ctx context.Context, limit int) ([]recordingpipeline.HeldCaptureSlot, error) {
	rows, err := r.queries.ListHeldCaptureSlots(ctx, int32(limit))
	if err != nil {
		return nil, fmt.Errorf("list held capture slots: %w", err)
	}
	slots := make([]recordingpipeline.HeldCaptureSlot, 0, len(rows))
	for _, row := range rows {
		slots = append(slots, recordingpipeline.HeldCaptureSlot{
			JobID: id(row.ID), TenantID: id(row.TenantID), RecordingID: id(row.RecordingID), EpisodeID: id(row.EpisodeID),
			ClaimedAt: timestamp(row.ClaimedAt), LeaseExpiresAt: timestamp(row.LeaseExpiresAt),
		})
	}
	return slots, nil
}
