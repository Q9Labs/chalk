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
		if replay, found, err := claimReplay(ctx, r.queries, input); err != nil || found {
			return replay, err
		}
	}
	if r.transactor == nil {
		return recordingpipeline.Job{}, errors.New("recording claim transaction is unavailable")
	}
	var claimed recordingpipeline.Job
	claim := recordingClaim{repo: r, input: input, issuedAt: r.now().UTC()}
	err := r.transaction(ctx, func(tx pgx.Tx, queries recordingPipelineQuerier) error {
		var err error
		claimed, err = claim.run(ctx, queries)
		return err
	})
	if err == nil {
		return claimed, nil
	}
	if r.queries != nil && (uniqueConstraintViolation(err, "recording_job_attempt_authorities_claim_request_id_key") || errors.Is(err, recordingpipeline.ErrJobNotFound)) {
		if replay, found, replayErr := claimReplay(ctx, r.queries, input); replayErr != nil || found {
			return replay, replayErr
		}
	}
	return recordingpipeline.Job{}, err
}

// recordingClaim is one worker claim inside its transaction.
type recordingClaim struct {
	repo     RecordingPipelineRepository
	input    recordingpipeline.ClaimInput
	issuedAt time.Time
}

func (c recordingClaim) run(ctx context.Context, queries recordingPipelineQuerier) (recordingpipeline.Job, error) {
	input := c.input
	if err := queries.LockRecordingJobClaimRequest(ctx, input.ClaimRequestID.String()); err != nil {
		return recordingpipeline.Job{}, fmt.Errorf("lock recording claim request: %w", err)
	}
	if replay, found, err := claimReplay(ctx, queries, input); err != nil || found {
		return replay, err
	}
	if err := c.admitWorker(ctx, queries); err != nil {
		return recordingpipeline.Job{}, err
	}
	row, err := c.leaseJob(ctx, queries)
	if err != nil {
		return recordingpipeline.Job{}, err
	}
	claimed := mapClaimJob(row)
	leaseExpiresAt := timestamp(row.LeaseExpiresAt)
	claimed.CaptureEpoch = row.CaptureEpoch
	claimed.CompletionOnly = row.CompletionOnly
	facts, err := c.claimFacts(ctx, queries, claimed, row)
	if err != nil {
		return recordingpipeline.Job{}, err
	}
	authority, err := recordingpipeline.NewRecorderJobAuthority(claimed, facts, input.ClaimRequestID, c.issuedAt)
	if err != nil {
		return recordingpipeline.Job{}, err
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
		EnvelopeDigest: authority.EnvelopeDigest, IssuedAt: timestamptzValue(c.issuedAt),
	}); err != nil {
		return recordingpipeline.Job{}, err
	}
	if claimed.Kind == recordingpipeline.JobKindRender || claimed.Kind == recordingpipeline.JobKindTranscription {
		if err := c.insertRenderInput(ctx, queries, claimed, row, facts, authority, leaseExpiresAt); err != nil {
			return recordingpipeline.Job{}, err
		}
	}
	if claimed.Kind == recordingpipeline.JobKindCapture {
		traceID, spanID, _, _ := lifecycleTraceContext(ctx)
		if err := queries.InsertRecordingClaimedEvent(ctx, sqlc.InsertRecordingClaimedEventParams{
			JobID: uuid(claimed.ID), LeaseOwner: input.Owner, TraceID: optionalText(traceID), SpanID: optionalText(spanID),
		}); err != nil {
			return recordingpipeline.Job{}, fmt.Errorf("record recording claim: %w", err)
		}
	}
	claimed.Authority = &authority
	return claimed, nil
}

// admitWorker locks the worker's admission row. Admission closure updates it, so a closure cannot
// overtake an in-flight claim.
func (c recordingClaim) admitWorker(ctx context.Context, queries recordingPipelineQuerier) error {
	role := string(c.input.Kind)
	if c.input.Kind == recordingpipeline.JobKindTranscription {
		role = string(recordingpipeline.PoolRoleRender)
	}
	authorized, err := queries.LockRecordingFleetWorkerClaim(ctx, sqlc.LockRecordingFleetWorkerClaimParams{
		Role: role, LeaseOwner: c.input.Owner, ColocatedEnabled: c.repo.colocatedGrace > 0,
	})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("lock recording worker admission: %w", err)
	}
	// Authentication can precede row loss. Managed claims must still have
	// an admitted binding here, in the transaction that creates the lease.
	if errors.Is(err, pgx.ErrNoRows) && c.input.ManagedWorker || err == nil && !authorized {
		return recordingpipeline.ErrJobNotFound
	}
	return nil
}

func (c recordingClaim) leaseJob(ctx context.Context, queries recordingPipelineQuerier) (sqlc.ClaimRecordingJobRow, error) {
	row, err := queries.ClaimRecordingJob(ctx, sqlc.ClaimRecordingJobParams{
		TranscriptionEnabled:   c.repo.transcriptionEnabled,
		SupportsCompletionOnly: c.input.SupportsCompletionOnly,
		MaximumRenderSeconds:   int32(recordingpipeline.MaximumRenderDuration / time.Second),
		LeaseToken:             requiredTextValue(c.input.LeaseToken),
		LeaseOwner:             c.input.Owner,
		LeaseExpiresAt:         timestamptzValue(c.issuedAt.Add(c.input.LeaseFor)),
		Kind:                   string(c.input.Kind),
		ColocatedGraceSeconds:  colocatedGraceSeconds(c.repo.colocatedGrace),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return row, recordingpipeline.ErrJobNotFound
	}
	if err != nil {
		return row, fmt.Errorf("claim recording job: %w", err)
	}
	return row, nil
}

// claimFacts collects what the worker's envelope must carry: the deadline, and per job kind the
// bundle schema of a capture or the presentation source of a render.
func (c recordingClaim) claimFacts(ctx context.Context, queries recordingPipelineQuerier, claimed recordingpipeline.Job, row sqlc.ClaimRecordingJobRow) (recordingpipeline.ClaimFacts, error) {
	hardDeadline, err := recordingJobDeadline(claimed.Kind, row.EndsAt, row.ExecutionStartedAt)
	if err != nil {
		return recordingpipeline.ClaimFacts{}, err
	}
	facts := recordingpipeline.ClaimFacts{
		SpaceID: utilities.IDFromBytes(row.SpaceID.Bytes), PolicySnapshotVersion: row.PolicySnapshotVersion,
		HardDeadline: hardDeadline, CaptureEpoch: row.CaptureEpoch, CaptureReadyAt: nullableTimestamp(row.CaptureReadyAt), CompletionOnly: row.CompletionOnly,
	}
	if claimed.Kind == recordingpipeline.JobKindCapture {
		facts.BundleSchemaVersion, err = c.captureBundleSchema(ctx, queries, claimed)
		if err != nil {
			return facts, err
		}
	}
	if claimed.Kind == recordingpipeline.JobKindRender || claimed.Kind == recordingpipeline.JobKindTranscription {
		facts.CaptureKeyHandle = utilities.IDFromBytes(row.CaptureKeyHandle.Bytes)
		facts.PresentationHandle = utilities.IDFromBytes(row.PresentationHandle.Bytes)
		facts.PresentationSchemaVersion = row.PresentationSchemaVersion.String
		facts.PresentationProfileVersion = row.PresentationProfileVersion.String
		facts.PresentationSHA256 = append([]byte(nil), row.PresentationSha256...)
		facts.PresentationDurationMillis = row.PresentationDurationMillis.Int64
	}
	return facts, nil
}

// captureBundleSchema keeps the bundle schema of an earlier attempt of the same capture job.
func (c recordingClaim) captureBundleSchema(ctx context.Context, queries recordingPipelineQuerier, claimed recordingpipeline.Job) (string, error) {
	previous, err := queries.GetRecordingCaptureJobEnvelope(ctx, uuid(claimed.ID))
	if errors.Is(err, pgx.ErrNoRows) {
		return captureBundleSchemaVersion(c.repo.recordingBundleV2Enabled, nil), nil
	}
	if err != nil {
		return "", fmt.Errorf("load original capture bundle schema: %w", err)
	}
	envelope, err := recordingpipeline.DecodeRecorderJobEnvelope(previous.EnvelopeBytes, previous.EnvelopeDigest)
	if err != nil || envelope.Kind != recordingpipeline.JobKindCapture || envelope.JobID != claimed.ID.String() {
		return "", recordingpipeline.ErrInvalidEnvelope
	}
	return captureBundleSchemaVersion(c.repo.recordingBundleV2Enabled, &envelope), nil
}

func (c recordingClaim) insertRenderInput(ctx context.Context, queries recordingPipelineQuerier, claimed recordingpipeline.Job, row sqlc.ClaimRecordingJobRow, facts recordingpipeline.ClaimFacts, authority recordingpipeline.JobAuthority, leaseExpiresAt time.Time) error {
	renderInputHandle, parseInputErr := utilities.ParseID(authority.Envelope.RenderInputHandle)
	objectHandle, parseObjectErr := utilities.ParseID(authority.Envelope.ObjectHandle)
	if parseInputErr != nil || parseObjectErr != nil {
		return recordingpipeline.ErrInvalidEnvelope
	}
	if _, err := queries.InsertRecordingRenderInput(ctx, sqlc.InsertRecordingRenderInputParams{
		RenderInputHandle: uuid(renderInputHandle), TenantID: uuid(claimed.TenantID), SpaceID: uuid(facts.SpaceID),
		EpisodeID: uuid(claimed.EpisodeID), RecordingID: uuid(claimed.RecordingID), RenderJobID: uuid(claimed.ID),
		AttemptCount: int32(claimed.AttemptCount), FencingGeneration: claimed.FencingGeneration,
		CaptureEpoch: row.CaptureEpoch, EnvelopeDigest: authority.EnvelopeDigest,
		KeyHandle: uuid(facts.CaptureKeyHandle), ObjectHandle: uuid(objectHandle),
		PresentationHandle: uuid(facts.PresentationHandle), PresentationSchemaVersion: facts.PresentationSchemaVersion,
		PresentationProfileVersion: facts.PresentationProfileVersion, PresentationSha256: facts.PresentationSHA256,
		PresentationDurationMillis: facts.PresentationDurationMillis, CaptureReadyAt: row.CaptureReadyAt,
		LeaseToken: requiredTextValue(c.input.LeaseToken), LeaseOwner: requiredTextValue(c.input.Owner), LeaseExpiresAt: timestamptzValue(leaseExpiresAt),
	}); err != nil {
		return fmt.Errorf("persist recording render input authority: %w", err)
	}
	return nil
}

// claimReplay returns the job a repeated claim request already holds, if any.
func claimReplay(ctx context.Context, queries recordingPipelineQuerier, input recordingpipeline.ClaimInput) (recordingpipeline.Job, bool, error) {
	job, err := getClaimReplay(ctx, queries, input)
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.Job{}, false, nil
	}
	return job, err == nil, err
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
