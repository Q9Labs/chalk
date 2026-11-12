package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type recordingCapturePlanQuerier interface {
	GetLatestRecordingCapturePlan(context.Context, pgtype.UUID) (sqlc.RecordingCapturePlan, error)
	GetRecordingCapturePlanSource(context.Context, sqlc.GetRecordingCapturePlanSourceParams) (sqlc.GetRecordingCapturePlanSourceRow, error)
	InsertRecordingCapturePlan(context.Context, sqlc.InsertRecordingCapturePlanParams) (sqlc.RecordingCapturePlan, error)
	LockRecordingCapturePlanHandle(context.Context, string) error
	GetRecordingCapturePlanForCommand(context.Context, sqlc.GetRecordingCapturePlanForCommandParams) (sqlc.RecordingCapturePlan, error)
	RetireRecordingCapturePublication(context.Context, sqlc.RetireRecordingCapturePublicationParams) (int64, error)
}

type RecordingCapturePlanRepository struct {
	transactor recordingPipelineTransactor
	decorate   func(sqlc.Querier) sqlc.Querier
	now        func() time.Time
}

func NewRecordingCapturePlanRepositoryWithTransactor(
	transactor recordingPipelineTransactor,
	decorate func(sqlc.Querier) sqlc.Querier,
) RecordingCapturePlanRepository {
	return RecordingCapturePlanRepository{transactor: transactor, decorate: decorate, now: time.Now}
}

func NewRecordingCapturePlanRepositoryWithPool(pool *pgxpool.Pool) RecordingCapturePlanRepository {
	return RecordingCapturePlanRepository{transactor: pool, now: time.Now}
}

func (r RecordingCapturePlanRepository) Reconcile(ctx context.Context, input captureplan.WaitInput) (captureplan.Plan, error) {
	if r.transactor == nil {
		return captureplan.Plan{}, captureplan.ErrRepositoryUnavailable
	}
	transaction, err := r.transactor.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return captureplan.Plan{}, fmt.Errorf("begin capture plan reconciliation: %w", err)
	}
	defer transaction.Rollback(ctx)

	queries := sqlc.Querier(sqlc.New(transaction))
	if r.decorate != nil {
		queries = r.decorate(queries)
	}
	plan, err := r.reconcile(ctx, queries, input)
	if err != nil {
		return captureplan.Plan{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return captureplan.Plan{}, fmt.Errorf("commit capture plan reconciliation: %w", err)
	}
	return plan, nil
}

// RetireGone fences the observed pull to its immutable plan, records only the
// matching publication references, and appends the replacement plan in one
// transaction. The retirement is Episode-scoped so later Capture epochs cannot
// rebuild the stale pull from an old provider observation.
func (r RecordingCapturePlanRepository) RetireGone(ctx context.Context, command capturesignaling.Command, gone []captureplane.CaptureTrack) (int, error) {
	if r.transactor == nil {
		return 0, captureplan.ErrRepositoryUnavailable
	}
	if len(gone) == 0 {
		return 0, nil
	}
	transaction, err := r.transactor.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return 0, fmt.Errorf("begin capture publication retirement: %w", err)
	}
	defer transaction.Rollback(ctx)
	queries := sqlc.Querier(sqlc.New(transaction))
	if r.decorate != nil {
		queries = r.decorate(queries)
	}
	issued, err := queries.GetRecordingCapturePlanForCommand(ctx, sqlc.GetRecordingCapturePlanForCommandParams{
		JobID: uuid(command.Authority.JobID), AttemptCount: int32(command.Authority.AttemptCount),
		FencingGeneration: command.Authority.FencingGeneration, CaptureEpoch: int64(command.Authority.CaptureEpoch),
		Revision: int64(command.Identity.PlanRevision), EnvelopeDigest: command.Authority.EnvelopeDigest,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, captureplan.ErrPlanAuthorityMismatch
	}
	if err != nil {
		return 0, fmt.Errorf("read issued capture plan: %w", err)
	}
	handle := utilities.IDFromBytes(issued.PlanHandle.Bytes).String()
	if err := queries.LockRecordingCapturePlanHandle(ctx, handle); err != nil {
		return 0, fmt.Errorf("lock capture plan handle: %w", err)
	}
	input := captureplan.NewWaitInput(captureplan.PlanAuthority{
		PlanHandle: captureplan.PlanHandle(handle), TenantID: command.Authority.TenantID,
		SpaceID: command.Authority.SpaceID, EpisodeID: command.Authority.EpisodeID,
		RecordingID: command.Authority.RecordingID, JobID: command.Authority.JobID,
		AttemptCount: command.Authority.AttemptCount, FencingGeneration: command.Authority.FencingGeneration,
		CaptureEpoch: command.Authority.CaptureEpoch, EnvelopeDigest: command.Authority.EnvelopeDigest,
	}, captureplan.WorkerLease{Owner: command.Lease.Owner, Token: command.Lease.Token, ExpiresAt: command.Lease.ExpiresAt}, 0, captureplan.MinimumWait)
	if err := validateStoredCapturePlan(issued, input); err != nil {
		return 0, err
	}
	plan, err := captureplan.DecodePlan(issued.PlanBytes, fmt.Sprintf("%x", issued.PlanFingerprint))
	if err != nil {
		return 0, err
	}
	issuedTracks := plan.Tracks()
	retired := 0
	for _, missing := range gone {
		var publication captureplan.PublicationReference
		for _, track := range issuedTracks {
			if track.ParticipantID == missing.ParticipantID && track.ParticipantGeneration == missing.ParticipantGeneration &&
				track.Source == missing.Source && track.Kind == missing.Kind && track.OwnerReference == missing.OwnerReference &&
				track.TrackReference == missing.TrackReference && track.RequestedLayer == missing.RequestedLayer {
				publication = track.PublicationReference
				break
			}
		}
		if publication == "" {
			return 0, captureplan.ErrInvalidTrack
		}
		count, err := queries.RetireRecordingCapturePublication(ctx, sqlc.RetireRecordingCapturePublicationParams{
			TenantID: uuid(input.TenantID), EpisodeID: uuid(input.EpisodeID), PublicationID: string(publication),
		})
		if err != nil {
			return 0, fmt.Errorf("retire capture publication: %w", err)
		}
		retired += int(count)
	}
	if retired > 0 {
		if _, err := r.reconcile(ctx, queries, input); err != nil && !errors.Is(err, captureplan.ErrNoChange) {
			return 0, err
		}
	}
	if err := transaction.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit capture publication retirement: %w", err)
	}
	return retired, nil
}

func (r RecordingCapturePlanRepository) reconcile(ctx context.Context, queries recordingCapturePlanQuerier, input captureplan.WaitInput) (captureplan.Plan, error) {
	if err := queries.LockRecordingCapturePlanHandle(ctx, string(input.PlanHandle)); err != nil {
		return captureplan.Plan{}, fmt.Errorf("lock capture plan handle: %w", err)
	}
	source, err := queries.GetRecordingCapturePlanSource(ctx, sqlc.GetRecordingCapturePlanSourceParams{
		JobID: uuid(input.JobID), AttemptCount: int32(input.AttemptCount),
		FencingGeneration: input.FencingGeneration, CaptureEpoch: int64(input.CaptureEpoch),
		EnvelopeDigest: input.EnvelopeDigest, LeaseToken: input.LeaseToken, LeaseOwner: input.LeaseOwner,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return captureplan.Plan{}, captureplan.ErrPlanAuthorityMismatch
	}
	if err != nil {
		return captureplan.Plan{}, fmt.Errorf("read capture plan source: %w", err)
	}

	latest, latestErr := queries.GetLatestRecordingCapturePlan(ctx, uuidString(string(input.PlanHandle)))
	if latestErr != nil && !errors.Is(latestErr, pgx.ErrNoRows) {
		return captureplan.Plan{}, fmt.Errorf("read latest capture plan: %w", latestErr)
	}
	if latestErr == nil {
		if err := validateStoredCapturePlan(latest, input); err != nil {
			return captureplan.Plan{}, err
		}
	}
	if (latestErr == nil && input.AfterRevision > captureplane.PlanRevision(latest.Revision)) ||
		(latestErr != nil && input.AfterRevision > 0) {
		return captureplan.Plan{}, captureplan.ErrStalePlan
	}

	revision := int64(1)
	if latestErr == nil {
		revision = latest.Revision
	}
	now := r.now().UTC()
	plan, err := buildRecordingCapturePlan(source, input, revision, now)
	if err != nil {
		return captureplan.Plan{}, err
	}
	if latestErr == nil && bytes.Equal(latest.PlanFingerprint, plan.FingerprintBytes()) {
		if plan.Revision() <= input.AfterRevision {
			return captureplan.Plan{}, captureplan.ErrNoChange
		}
		return plan, nil
	}
	if latestErr == nil {
		if latest.Revision == math.MaxInt64 {
			return captureplan.Plan{}, captureplan.ErrInvalidPlan
		}
		revision = latest.Revision + 1
		plan, err = buildRecordingCapturePlan(source, input, revision, now)
		if err != nil {
			return captureplan.Plan{}, err
		}
	}

	inserted, err := queries.InsertRecordingCapturePlan(ctx, sqlc.InsertRecordingCapturePlanParams{
		PlanHandle: uuidString(string(input.PlanHandle)), Revision: revision,
		JobID: uuid(input.JobID), AttemptCount: int32(input.AttemptCount),
		FencingGeneration: input.FencingGeneration, CaptureEpoch: int64(input.CaptureEpoch),
		EnvelopeDigest: input.EnvelopeDigest, TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID),
		EpisodeID: uuid(input.EpisodeID), RecordingID: uuid(input.RecordingID),
		EpisodeControlRevision: plan.Cursors().EpisodeControlRevision,
		ProviderIncarnation:    plan.Cursors().ProviderIncarnation, ProviderSequence: plan.Cursors().ProviderSequence,
		PlanSchemaVersion: captureplan.SchemaVersion, PlanBytes: plan.CanonicalJSON(),
		PlanFingerprint: plan.FingerprintBytes(), EffectiveDeadlineAt: timestamptzValue(plan.EffectiveDeadline()),
	})
	if err != nil {
		return captureplan.Plan{}, fmt.Errorf("append capture plan: %w", err)
	}
	if !bytes.Equal(inserted.PlanFingerprint, plan.FingerprintBytes()) || !bytes.Equal(inserted.PlanBytes, plan.CanonicalJSON()) {
		return captureplan.Plan{}, captureplan.ErrInvalidPlan
	}
	return plan, nil
}
