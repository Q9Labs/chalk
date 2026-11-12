package postgres

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleetauthority"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

type recordingFleetAuthorityQuerier interface {
	ObserveRecordingFleetIdentityLeases(context.Context, sqlc.ObserveRecordingFleetIdentityLeasesParams) (sqlc.ObserveRecordingFleetIdentityLeasesRow, error)
	AbandonRecordingFleetBootstrap(context.Context, sqlc.AbandonRecordingFleetBootstrapParams) (string, error)
	ActivateRecordingFleetBootstrap(context.Context, sqlc.ActivateRecordingFleetBootstrapParams) (sqlc.RecordingFleetNode, error)
	AuthorizeRecordingFleetWorker(context.Context, sqlc.AuthorizeRecordingFleetWorkerParams) (bool, error)
	AuthorizeRecordingFleetWorkerClaim(context.Context, sqlc.AuthorizeRecordingFleetWorkerClaimParams) (sqlc.AuthorizeRecordingFleetWorkerClaimRow, error)
	CloseRecordingFleetNodeAdmission(context.Context, sqlc.CloseRecordingFleetNodeAdmissionParams) (string, error)
	EnsureRecordingColocatedCaptureWorker(context.Context, sqlc.EnsureRecordingColocatedCaptureWorkerParams) error
	RecordRecordingColocatedWorkerObservation(context.Context, sqlc.RecordRecordingColocatedWorkerObservationParams) (sqlc.RecordRecordingColocatedWorkerObservationRow, error)
	GetRecordingFleetDemand(context.Context, sqlc.GetRecordingFleetDemandParams) (sqlc.GetRecordingFleetDemandRow, error)
	ListRecordingFleetNodeObservations(context.Context, sqlc.ListRecordingFleetNodeObservationsParams) ([]sqlc.ListRecordingFleetNodeObservationsRow, error)
	PublishRecordingFleetPool(context.Context, sqlc.PublishRecordingFleetPoolParams) (string, error)
	RecordRecordingFleetWorkerObservation(context.Context, sqlc.RecordRecordingFleetWorkerObservationParams) (sqlc.RecordRecordingFleetWorkerObservationRow, error)
	ReserveRecordingFleetBootstrap(context.Context, sqlc.ReserveRecordingFleetBootstrapParams) (sqlc.RecordingFleetNode, error)
	RevokeRecordingFleetNode(context.Context, sqlc.RevokeRecordingFleetNodeParams) (string, error)
}

type RecordingFleetAuthorityRepository struct {
	admissionLimits recordingpipeline.AdmissionLimits
	ownCapture      bool
	colocatedGrace  time.Duration
	queries         recordingFleetAuthorityQuerier
}

func NewRecordingFleetAuthorityRepository(queries recordingFleetAuthorityQuerier) RecordingFleetAuthorityRepository {
	return RecordingFleetAuthorityRepository{queries: queries}
}

func (r RecordingFleetAuthorityRepository) GetDemand(ctx context.Context, key recorderfleet.PoolKey, observedAt time.Time) (recorderfleet.Demand, error) {
	if r.queries == nil {
		return recorderfleet.Demand{}, recorderfleet.ErrProviderUnavailable
	}
	row, err := r.queries.GetRecordingFleetDemand(ctx, sqlc.GetRecordingFleetDemandParams{
		RecordingCap: int32(r.admissionLimits.WithDefaults().RecordingCap), Role: string(key.Role), ObservedAt: timestamptzValue(observedAt), OwnCapture: r.ownCapture,
		ColocatedGraceSeconds: colocatedGraceSeconds(r.colocatedGrace),
	})
	if err != nil {
		return recorderfleet.Demand{}, fmt.Errorf("read recording fleet demand: %w", err)
	}
	if row.Revision == "" || !row.ObservedAt.Valid {
		return recorderfleet.Demand{}, recorderfleet.ErrInventoryDrift
	}
	demand := recorderfleet.Demand{
		Revision: row.Revision, DesiredNodes: int(row.DesiredNodes), ScheduledPrewarms: int(row.ScheduledPrewarms),
		HeldStarts: int(row.HeldStarts), QueuedJobs: int(row.QueuedJobs), ObservedAt: row.ObservedAt.Time,
	}
	if key.Role == workeridentity.RoleCapture {
		demand.CaptureCapacity = &recorderfleet.CaptureCapacityDemand{SlotDemand: int(row.SlotDemand), PhysicalNodeFloor: int(row.PhysicalNodeFloor)}
	}
	return demand, nil
}

func (r RecordingFleetAuthorityRepository) ObserveNodes(ctx context.Context, key recorderfleet.PoolKey, observedAt time.Time) ([]recorderfleet.NodeObservation, error) {
	if r.queries == nil {
		return nil, recorderfleet.ErrProviderUnavailable
	}
	rows, err := r.queries.ListRecordingFleetNodeObservations(ctx, sqlc.ListRecordingFleetNodeObservationsParams{
		Environment: key.Environment, Role: string(key.Role),
	})
	if err != nil {
		return nil, fmt.Errorf("list recording fleet observations: %w", err)
	}
	observations := make([]recorderfleet.NodeObservation, 0, len(rows))
	for _, row := range rows {
		identity, err := recordingFleetIdentity(row.ProviderID, row.WorkerID, row.Role, row.BootGeneration)
		if err != nil || !row.ObservedAt.Valid || row.ReadyCapacity < 0 || row.ActiveLeases < 0 {
			return nil, recorderfleet.ErrInventoryDrift
		}
		observations = append(observations, recorderfleet.NodeObservation{
			Identity: identity, Ready: row.Ready, AdmissionOpen: row.AdmissionOpen,
			ReadyCapacity: int(row.ReadyCapacity), ActiveLeases: int(row.ActiveLeases), ObservedAt: row.ObservedAt.Time,
			// Request freshness is separate from the database clock used for lease expiry.
			LeasesObservedAt: observedAt, IdentityRevoked: row.IdentityRevoked,
		})
	}
	return observations, nil
}

func (r RecordingFleetAuthorityRepository) ObserveIdentity(ctx context.Context, environment string, identity recorderfleet.NodeIdentity, observedAt time.Time) (recorderfleet.NodeObservation, error) {
	workerID, generation, err := recordingFleetMutationIdentity(identity)
	if err != nil {
		return recorderfleet.NodeObservation{}, err
	}
	if r.queries == nil {
		return recorderfleet.NodeObservation{}, recorderfleet.ErrProviderUnavailable
	}
	row, err := r.queries.ObserveRecordingFleetIdentityLeases(ctx, sqlc.ObserveRecordingFleetIdentityLeasesParams{
		Environment: environment, Role: string(identity.Role), ProviderID: identity.ProviderID, WorkerID: workerID, BootGeneration: generation,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recorderfleet.NodeObservation{}, recorderfleet.ErrRoleFence
	}
	if err != nil {
		return recorderfleet.NodeObservation{}, fmt.Errorf("observe recorder identity leases: %w", err)
	}
	if row.ActiveLeases < 0 {
		return recorderfleet.NodeObservation{}, recorderfleet.ErrInventoryDrift
	}
	return recorderfleet.NodeObservation{Identity: identity, ActiveLeases: int(row.ActiveLeases), LeasesObservedAt: observedAt, IdentityAbsent: row.IdentityAbsent, IdentityRevoked: row.IdentityRevoked}, nil
}

func recordingFleetIdentity(providerID string, workerID pgtype.UUID, role string, bootGeneration int64) (recorderfleet.NodeIdentity, error) {
	if !workerID.Valid || bootGeneration <= 0 {
		return recorderfleet.NodeIdentity{}, recorderfleet.ErrInventoryDrift
	}
	return recorderfleet.NodeIdentity{
		ProviderID: providerID, WorkerID: nullableID(workerID).String(),
		Role: workeridentity.Role(role), BootGeneration: uint64(bootGeneration),
	}, nil
}

func recordingFleetMutationIdentity(identity recorderfleet.NodeIdentity) (pgtype.UUID, int64, error) {
	workerID, err := parseRecordingFleetWorkerID(identity.WorkerID)
	if err != nil {
		return pgtype.UUID{}, 0, err
	}
	bootGeneration, ok := recordingFleetGeneration(identity.BootGeneration)
	if !ok {
		return pgtype.UUID{}, 0, recorderfleet.ErrRoleFence
	}
	return workerID, bootGeneration, nil
}

func parseRecordingFleetWorkerID(value string) (pgtype.UUID, error) {
	workerID, err := utilities.ParseID(value)
	if err != nil || workerID.IsZero() {
		return pgtype.UUID{}, recorderfleet.ErrRoleFence
	}
	return uuid(workerID), nil
}

func recordingFleetGeneration(value uint64) (int64, bool) {
	return int64(value), value > 0 && value <= math.MaxInt64
}

func recordingFleetNodeMutationError(operation string, err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return recorderfleet.ErrNodeNotFound
	}
	if err != nil {
		return fmt.Errorf("%s: %w", operation, err)
	}
	return nil
}

func isUniqueViolation(err error) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && postgresError.Code == "23505"
}

var _ recorderfleetauthority.Repository = RecordingFleetAuthorityRepository{}

// WithOwnCapture says the recorder can reach the own SFU's nodes, so a preparation for a Space on
// it counts as demand. Without it the own SFU has no capture path, and no such preparation counts.
func (r RecordingFleetAuthorityRepository) WithOwnCapture(enabled bool) RecordingFleetAuthorityRepository {
	r.ownCapture = enabled
	return r
}

func (r RecordingFleetAuthorityRepository) WithAdmissionLimits(limits recordingpipeline.AdmissionLimits) RecordingFleetAuthorityRepository {
	r.admissionLimits = limits.WithDefaults()
	return r
}

// WithColocatedCapture turns on capture workers beside own-SFU nodes. A capture waits for the
// healthy worker of its Episode's node for the grace, then the fleet may take it. Zero is off.
func (r RecordingFleetAuthorityRepository) WithColocatedCapture(grace time.Duration) RecordingFleetAuthorityRepository {
	r.colocatedGrace = grace
	return r
}
