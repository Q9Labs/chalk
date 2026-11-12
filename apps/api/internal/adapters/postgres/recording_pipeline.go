package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/tenantlimits"
)

type recordingPipelineQuerier interface {
	GetRecordingCaptureCompletionIdentity(context.Context, pgtype.UUID) (pgtype.UUID, error)
	ClaimRecordingJob(context.Context, sqlc.ClaimRecordingJobParams) (sqlc.ClaimRecordingJobRow, error)
	InsertRecordingClaimedEvent(context.Context, sqlc.InsertRecordingClaimedEventParams) error
	LockRecordingJobClaimRequest(context.Context, string) error
	LockRecordingFleetWorkerClaim(context.Context, sqlc.LockRecordingFleetWorkerClaimParams) (bool, error)
	GetRecordingJobAttemptAuthorityByClaimRequest(context.Context, pgtype.UUID) (sqlc.GetRecordingJobAttemptAuthorityByClaimRequestRow, error)
	GetRecordingCaptureJobEnvelope(context.Context, pgtype.UUID) (sqlc.GetRecordingCaptureJobEnvelopeRow, error)
	InsertRecordingJobAttemptAuthority(context.Context, sqlc.InsertRecordingJobAttemptAuthorityParams) (sqlc.RecordingJobAttemptAuthority, error)
	InsertRecordingRenderInput(context.Context, sqlc.InsertRecordingRenderInputParams) (sqlc.RecordingRenderInput, error)
	RequestDeferredRecordingRender(context.Context, sqlc.RequestDeferredRecordingRenderParams) (sqlc.RequestDeferredRecordingRenderRow, error)
	AuthorizeRecordingArtifactReplay(context.Context, sqlc.AuthorizeRecordingArtifactReplayParams) (bool, error)
	CommitRecordingArtifact(context.Context, sqlc.CommitRecordingArtifactParams) (sqlc.CommitRecordingArtifactRow, error)
	CompleteCaptureRecordingJob(context.Context, sqlc.CompleteCaptureRecordingJobParams) (sqlc.CompleteCaptureRecordingJobRow, error)
	GetCompletedCaptureRecordingJob(context.Context, sqlc.GetCompletedCaptureRecordingJobParams) (sqlc.RecordingJob, error)
	CompleteRecordingJob(context.Context, sqlc.CompleteRecordingJobParams) (sqlc.RecordingJob, error)
	CreateRecordingReservation(context.Context, sqlc.CreateRecordingReservationParams) (sqlc.CreateRecordingReservationRow, error)
	GetRecordingArtifact(context.Context, sqlc.GetRecordingArtifactParams) (sqlc.RecordingArtifact, error)
	GetRecordingReservationFingerprint(context.Context, sqlc.GetRecordingReservationFingerprintParams) ([]byte, error)
	GetRecordingReservationByKey(context.Context, sqlc.GetRecordingReservationByKeyParams) (sqlc.GetRecordingReservationByKeyRow, error)
	ExtendRecordingReservation(context.Context, sqlc.ExtendRecordingReservationParams) (sqlc.ExtendRecordingReservationRow, error)
	FailRecordingJob(context.Context, sqlc.FailRecordingJobParams) (sqlc.FailRecordingJobRow, error)
	RelinquishCaptureRecordingJob(context.Context, sqlc.RelinquishCaptureRecordingJobParams) (sqlc.RelinquishCaptureRecordingJobRow, error)
	ListRecordingDeferredArtifactStates(context.Context, sqlc.ListRecordingDeferredArtifactStatesParams) ([]sqlc.ListRecordingDeferredArtifactStatesRow, error)
	GetRecordingPipeline(context.Context, sqlc.GetRecordingPipelineParams) (sqlc.GetRecordingPipelineRow, error)
	GetRecordingPipelineStopAuthority(context.Context, sqlc.GetRecordingPipelineStopAuthorityParams) (sqlc.GetRecordingPipelineStopAuthorityRow, error)
	RequestRecordingStop(context.Context, sqlc.RequestRecordingStopParams) (sqlc.RequestRecordingStopRow, error)
	GetRecordingReservation(context.Context, sqlc.GetRecordingReservationParams) (sqlc.GetRecordingReservationRow, error)
	HeartbeatRecordingJob(context.Context, sqlc.HeartbeatRecordingJobParams) (sqlc.RecordingJob, error)
	InsertRecordingBundle(context.Context, sqlc.InsertRecordingBundleParams) (sqlc.InsertRecordingBundleRow, error)
	InsertRecordingPresentation(context.Context, sqlc.InsertRecordingPresentationParams) (sqlc.RecordingPresentation, error)
	InsertRecordingPresentationAsset(context.Context, sqlc.InsertRecordingPresentationAssetParams) (sqlc.RecordingPresentationAsset, error)
	ListRecordingDeadLetters(context.Context, sqlc.ListRecordingDeadLettersParams) ([]sqlc.RecordingJob, error)
	ListRecordingJobsForReconciliation(context.Context, sqlc.ListRecordingJobsForReconciliationParams) ([]sqlc.RecordingJob, error)
	LockRecordingCapacity(context.Context) (int16, error)
	ExpireRecordingReservations(context.Context, pgtype.Timestamptz) ([]sqlc.ExpireRecordingReservationsRow, error)
	RecoverExpiredRecordingJobs(context.Context, int32) ([]sqlc.RecoverExpiredRecordingJobsRow, error)
	DrainCaptureStopPublications(context.Context, pgtype.Timestamptz) error
	ReleaseRecordingReservation(context.Context, sqlc.ReleaseRecordingReservationParams) (sqlc.ReleaseRecordingReservationRow, error)
	UpsertRecordingPoolHealth(context.Context, sqlc.UpsertRecordingPoolHealthParams) (sqlc.UpsertRecordingPoolHealthRow, error)
	GetRecordingPoolHealth(context.Context, string) (sqlc.GetRecordingPoolHealthRow, error)
	ListHeldCaptureSlots(context.Context, int32) ([]sqlc.ListHeldCaptureSlotsRow, error)
}

type recordingPipelineTransactor interface {
	BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error)
}

type RecordingPipelineRepository struct {
	admissionLimits          recordingpipeline.AdmissionLimits
	tenantLimits             tenantlimits.Config
	queries                  recordingPipelineQuerier
	transactor               recordingPipelineTransactor
	decorate                 func(sqlc.Querier) sqlc.Querier
	now                      func() time.Time
	presentationProfile      *recordingpresentation.Profile
	presentationFreezer      *recordingpresentation.Freezer
	transcriptionEnabled     bool
	recordingBundleV2Enabled bool
	colocatedGrace           time.Duration
}

func NewRecordingPipelineRepository(queries recordingPipelineQuerier) RecordingPipelineRepository {
	return RecordingPipelineRepository{queries: queries, now: time.Now}
}

func NewRecordingPipelineRepositoryWithTransactor(transactor recordingPipelineTransactor) RecordingPipelineRepository {
	return RecordingPipelineRepository{transactor: transactor, now: time.Now}
}

func NewRecordingPipelineRepositoryWithQueriesAndTransactor(queries recordingPipelineQuerier, transactor recordingPipelineTransactor, decorate func(sqlc.Querier) sqlc.Querier) RecordingPipelineRepository {
	return RecordingPipelineRepository{queries: queries, transactor: transactor, decorate: decorate, now: time.Now}
}

func NewRecordingPipelineRepositoryWithPool(pool *pgxpool.Pool) RecordingPipelineRepository {
	return RecordingPipelineRepository{queries: sqlc.New(pool), transactor: pool, now: time.Now}
}

func (r RecordingPipelineRepository) WithRecordingPresentationProfile(profile recordingpresentation.Profile) (RecordingPipelineRepository, error) {
	if err := recordingpresentation.ValidateProfile(profile); err != nil {
		return RecordingPipelineRepository{}, fmt.Errorf("configure recording presentation profile: %w", err)
	}
	copy := profile
	copy.FontAssetIDs = append([]string{}, profile.FontAssetIDs...)
	r.presentationProfile = &copy
	return r, nil
}

// WithRecordingPresentationFreezer binds the unlocked immutable-object prepare
// phase to capture completion. The repository still performs the final
// lease-guarded presentation insert and render enqueue in one transaction.
func (r RecordingPipelineRepository) WithRecordingPresentationFreezer(freezer recordingpresentation.Freezer) RecordingPipelineRepository {
	r.presentationFreezer = &freezer
	return r
}

// WithTranscriptionEnabled uses the existing global transcription capability
// as the rollout gate for automatic audio-preparation jobs.
func (r RecordingPipelineRepository) WithTranscriptionEnabled(enabled bool) RecordingPipelineRepository {
	r.transcriptionEnabled = enabled
	return r
}

// WithColocatedCapture turns on capture workers beside own-SFU nodes: such a worker claims only the
// captures of its own node, and the fleet leaves a capture to a healthy one for the grace.
func (r RecordingPipelineRepository) WithColocatedCapture(grace time.Duration) RecordingPipelineRepository {
	r.colocatedGrace = grace
	return r
}

func (r RecordingPipelineRepository) WithRecordingBundleV2Enabled(enabled bool) RecordingPipelineRepository {
	r.recordingBundleV2Enabled = enabled
	return r
}

func (r RecordingPipelineRepository) transaction(ctx context.Context, work func(pgx.Tx, recordingPipelineQuerier) error) error {
	if r.transactor == nil {
		return errors.New("recording pipeline transaction is unavailable")
	}
	tx, err := r.transactor.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return fmt.Errorf("begin recording pipeline transaction: %w", err)
	}
	defer tx.Rollback(ctx)
	var queries sqlc.Querier = sqlc.New(tx)
	if r.decorate != nil {
		queries = r.decorate(queries)
	}
	if err := work(tx, queries); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit recording pipeline transaction: %w", err)
	}
	return nil
}

func nullableTextPointer(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	result := value.String
	return &result
}

func requiredTextValue(value string) pgtype.Text {
	return pgtype.Text{String: value, Valid: true}
}

func timestamptzValue(value time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: value, Valid: true}
}

var _ recordingpipeline.Repository = RecordingPipelineRepository{}

func (r RecordingPipelineRepository) WithTenantLimits(limits tenantlimits.Config) RecordingPipelineRepository {
	r.tenantLimits = limits
	return r
}

func (r RecordingPipelineRepository) WithAdmissionLimits(limits recordingpipeline.AdmissionLimits) RecordingPipelineRepository {
	r.admissionLimits = limits.WithDefaults()
	return r
}
