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
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

type recordingFleetAuthorityQuerier interface {
	ActivateRecordingFleetBootstrap(context.Context, sqlc.ActivateRecordingFleetBootstrapParams) (sqlc.RecordingFleetNode, error)
	AuthorizeRecordingFleetWorker(context.Context, sqlc.AuthorizeRecordingFleetWorkerParams) (bool, error)
	AuthorizeRecordingFleetWorkerClaim(context.Context, sqlc.AuthorizeRecordingFleetWorkerClaimParams) (bool, error)
	CloseRecordingFleetNodeAdmission(context.Context, sqlc.CloseRecordingFleetNodeAdmissionParams) (string, error)
	GetRecordingFleetDemand(context.Context, sqlc.GetRecordingFleetDemandParams) (sqlc.GetRecordingFleetDemandRow, error)
	ListRecordingFleetNodeObservations(context.Context, sqlc.ListRecordingFleetNodeObservationsParams) ([]sqlc.ListRecordingFleetNodeObservationsRow, error)
	PublishRecordingFleetPool(context.Context, sqlc.PublishRecordingFleetPoolParams) (string, error)
	RecordRecordingFleetWorkerObservation(context.Context, sqlc.RecordRecordingFleetWorkerObservationParams) (sqlc.RecordRecordingFleetWorkerObservationRow, error)
	ReserveRecordingFleetBootstrap(context.Context, sqlc.ReserveRecordingFleetBootstrapParams) (sqlc.RecordingFleetNode, error)
	RevokeRecordingFleetNode(context.Context, sqlc.RevokeRecordingFleetNodeParams) (string, error)
}

type RecordingFleetAuthorityRepository struct {
	queries recordingFleetAuthorityQuerier
}

func NewRecordingFleetAuthorityRepository(queries recordingFleetAuthorityQuerier) RecordingFleetAuthorityRepository {
	return RecordingFleetAuthorityRepository{queries: queries}
}

func (r RecordingFleetAuthorityRepository) GetDemand(ctx context.Context, key recorderfleet.PoolKey, observedAt time.Time) (recorderfleet.Demand, error) {
	if r.queries == nil {
		return recorderfleet.Demand{}, recorderfleet.ErrProviderUnavailable
	}
	row, err := r.queries.GetRecordingFleetDemand(ctx, sqlc.GetRecordingFleetDemandParams{
		Role: string(key.Role), ObservedAt: timestamptzValue(observedAt),
	})
	if err != nil {
		return recorderfleet.Demand{}, fmt.Errorf("read recording fleet demand: %w", err)
	}
	if row.Revision == "" || !row.ObservedAt.Valid {
		return recorderfleet.Demand{}, recorderfleet.ErrInventoryDrift
	}
	return recorderfleet.Demand{
		Revision: row.Revision, DesiredNodes: int(row.DesiredNodes), ScheduledPrewarms: int(row.ScheduledPrewarms),
		HeldStarts: int(row.HeldStarts), QueuedJobs: int(row.QueuedJobs), ObservedAt: row.ObservedAt.Time,
	}, nil
}

func (r RecordingFleetAuthorityRepository) ObserveNodes(ctx context.Context, key recorderfleet.PoolKey, observedAt time.Time) ([]recorderfleet.NodeObservation, error) {
	if r.queries == nil {
		return nil, recorderfleet.ErrProviderUnavailable
	}
	rows, err := r.queries.ListRecordingFleetNodeObservations(ctx, sqlc.ListRecordingFleetNodeObservationsParams{
		ObservedAt: timestamptzValue(observedAt), Environment: key.Environment, Role: string(key.Role),
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
		})
	}
	return observations, nil
}

func (r RecordingFleetAuthorityRepository) ReserveBootstrap(ctx context.Context, request recorderfleet.BootstrapRequest) (recorderfleetauthority.BootstrapRecord, error) {
	if r.queries == nil {
		return recorderfleetauthority.BootstrapRecord{}, recorderfleet.ErrProviderUnavailable
	}
	bootGeneration, ok := recordingFleetGeneration(request.BootGeneration)
	if !ok {
		return recorderfleetauthority.BootstrapRecord{}, recorderfleet.ErrInventoryDrift
	}
	row, err := r.queries.ReserveRecordingFleetBootstrap(ctx, sqlc.ReserveRecordingFleetBootstrapParams{
		Environment: request.Key.Environment, Role: string(request.Key.Role), ProviderID: request.ProviderID,
		NodeName: request.NodeName, Region: request.Region, ReleaseID: request.ReleaseID,
		ImageDigest: request.ImageDigest, BootGeneration: bootGeneration, InventoryDigest: request.InventoryDigest,
	})
	if errors.Is(err, pgx.ErrNoRows) || isUniqueViolation(err) {
		return recorderfleetauthority.BootstrapRecord{}, recorderfleet.ErrInventoryDrift
	}
	if err != nil {
		return recorderfleetauthority.BootstrapRecord{}, fmt.Errorf("reserve recording fleet node: %w", err)
	}
	return recordingFleetBootstrapRecord(row)
}

func (r RecordingFleetAuthorityRepository) ActivateBootstrap(ctx context.Context, request recorderfleet.BootstrapRequest, identity recorderfleet.NodeIdentity) (recorderfleet.NodeIdentity, error) {
	if r.queries == nil {
		return recorderfleet.NodeIdentity{}, recorderfleet.ErrProviderUnavailable
	}
	workerID, err := parseRecordingFleetWorkerID(identity.WorkerID)
	if err != nil {
		return recorderfleet.NodeIdentity{}, err
	}
	bootGeneration, ok := recordingFleetGeneration(request.BootGeneration)
	if !ok {
		return recorderfleet.NodeIdentity{}, recorderfleet.ErrInventoryDrift
	}
	row, err := r.queries.ActivateRecordingFleetBootstrap(ctx, sqlc.ActivateRecordingFleetBootstrapParams{
		WorkerID: workerID, Environment: request.Key.Environment, Role: string(request.Key.Role),
		ProviderID: request.ProviderID, NodeName: request.NodeName, Region: request.Region,
		ReleaseID: request.ReleaseID, ImageDigest: request.ImageDigest, BootGeneration: bootGeneration,
		InventoryDigest: request.InventoryDigest,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recorderfleet.NodeIdentity{}, recorderfleet.ErrInventoryDrift
	}
	if isUniqueViolation(err) {
		return recorderfleet.NodeIdentity{}, recorderfleet.ErrRoleFence
	}
	if err != nil {
		return recorderfleet.NodeIdentity{}, fmt.Errorf("activate recording fleet node: %w", err)
	}
	return recordingFleetIdentity(row.ProviderID, row.WorkerID, row.Role, row.BootGeneration)
}

func (r RecordingFleetAuthorityRepository) CloseAdmission(ctx context.Context, environment string, identity recorderfleet.NodeIdentity) error {
	workerID, bootGeneration, err := recordingFleetMutationIdentity(identity)
	if err != nil {
		return err
	}
	if r.queries == nil {
		return recorderfleet.ErrProviderUnavailable
	}
	_, err = r.queries.CloseRecordingFleetNodeAdmission(ctx, sqlc.CloseRecordingFleetNodeAdmissionParams{
		Environment: environment, Role: string(identity.Role), ProviderID: identity.ProviderID,
		WorkerID: workerID, BootGeneration: bootGeneration,
	})
	return recordingFleetNodeMutationError("close recording fleet admission", err)
}

func (r RecordingFleetAuthorityRepository) MarkRevoked(ctx context.Context, environment string, identity recorderfleet.NodeIdentity, revokedAt time.Time) error {
	workerID, bootGeneration, err := recordingFleetMutationIdentity(identity)
	if err != nil {
		return err
	}
	if r.queries == nil {
		return recorderfleet.ErrProviderUnavailable
	}
	_, err = r.queries.RevokeRecordingFleetNode(ctx, sqlc.RevokeRecordingFleetNodeParams{
		RevokedAt: timestamptzValue(revokedAt), Environment: environment, Role: string(identity.Role),
		ProviderID: identity.ProviderID, WorkerID: workerID, BootGeneration: bootGeneration,
	})
	return recordingFleetNodeMutationError("revoke recording fleet node", err)
}

func (r RecordingFleetAuthorityRepository) PublishPool(ctx context.Context, projection recorderfleet.PoolProjection) error {
	if r.queries == nil {
		return recorderfleet.ErrProviderUnavailable
	}
	if projection.ReadyCapacity > math.MaxInt32 {
		return recorderfleet.ErrInventoryDrift
	}
	_, err := r.queries.PublishRecordingFleetPool(ctx, sqlc.PublishRecordingFleetPoolParams{
		Role: string(projection.Key.Role), AdmissionOpen: projection.AdmissionOpen,
		ReadyCapacity: int32(projection.ReadyCapacity), Reason: projection.Reason,
		ObservedAt: timestamptzValue(projection.ObservedAt), DemandRevision: projection.DemandRevision,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recorderfleet.ErrInventoryDrift
	}
	if err != nil {
		return fmt.Errorf("publish recording fleet pool: %w", err)
	}
	return nil
}

func (r RecordingFleetAuthorityRepository) RecordWorkerObservation(ctx context.Context, environment string, observation recorderfleetauthority.WorkerObservation) (recorderfleet.NodeObservation, error) {
	if r.queries == nil {
		return recorderfleet.NodeObservation{}, recorderfleet.ErrProviderUnavailable
	}
	if observation.ReadyCapacity > math.MaxInt32 {
		return recorderfleet.NodeObservation{}, recorderfleet.ErrInventoryDrift
	}
	row, err := r.queries.RecordRecordingFleetWorkerObservation(ctx, sqlc.RecordRecordingFleetWorkerObservationParams{
		Ready: observation.Ready, AdmissionOpen: observation.AdmissionOpen, ReadyCapacity: int32(observation.ReadyCapacity),
		Environment: environment, Role: string(observation.Identity.Role), WorkerID: uuid(observation.Identity.WorkerID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recorderfleet.NodeObservation{}, recorderfleet.ErrNodeNotFound
	}
	if err != nil {
		return recorderfleet.NodeObservation{}, fmt.Errorf("record recording fleet worker observation: %w", err)
	}
	identity, err := recordingFleetIdentity(row.ProviderID, row.WorkerID, row.Role, row.BootGeneration)
	if err != nil || !row.ObservedAt.Valid {
		return recorderfleet.NodeObservation{}, recorderfleet.ErrInventoryDrift
	}
	return recorderfleet.NodeObservation{
		Identity: identity, Ready: row.Ready, AdmissionOpen: row.AdmissionOpen,
		ReadyCapacity: int(row.ReadyCapacity), ObservedAt: row.ObservedAt.Time,
	}, nil
}

func (r RecordingFleetAuthorityRepository) AuthorizeWorker(ctx context.Context, environment string, identity workeridentity.Identity) error {
	if r.queries == nil {
		return recorderfleet.ErrProviderUnavailable
	}
	authorized, err := r.queries.AuthorizeRecordingFleetWorker(ctx, sqlc.AuthorizeRecordingFleetWorkerParams{
		Environment: environment, Role: string(identity.Role), WorkerID: uuid(identity.WorkerID),
	})
	if err != nil {
		return fmt.Errorf("authorize recording fleet worker: %w", err)
	}
	if !authorized {
		return recorderfleet.ErrNodeNotFound
	}
	return nil
}

func (r RecordingFleetAuthorityRepository) AuthorizeWorkerClaim(ctx context.Context, environment string, identity workeridentity.Identity) error {
	if r.queries == nil {
		return recorderfleet.ErrProviderUnavailable
	}
	authorized, err := r.queries.AuthorizeRecordingFleetWorkerClaim(ctx, sqlc.AuthorizeRecordingFleetWorkerClaimParams{
		Environment: environment, Role: string(identity.Role), WorkerID: uuid(identity.WorkerID),
	})
	if err != nil {
		return fmt.Errorf("authorize recording fleet worker claim: %w", err)
	}
	if !authorized {
		return recorderfleet.ErrAdmissionClosed
	}
	return nil
}

func recordingFleetBootstrapRecord(row sqlc.RecordingFleetNode) (recorderfleetauthority.BootstrapRecord, error) {
	if row.BootGeneration <= 0 {
		return recorderfleetauthority.BootstrapRecord{}, recorderfleet.ErrInventoryDrift
	}
	record := recorderfleetauthority.BootstrapRecord{Request: recorderfleet.BootstrapRequest{
		Key:        recorderfleet.PoolKey{Environment: row.Environment, Role: workeridentity.Role(row.Role)},
		ProviderID: row.ProviderID, NodeName: row.NodeName, Region: row.Region, ReleaseID: row.ReleaseID,
		ImageDigest: row.ImageDigest, BootGeneration: uint64(row.BootGeneration), InventoryDigest: row.InventoryDigest,
	}}
	if row.WorkerID.Valid {
		identity, err := recordingFleetIdentity(row.ProviderID, row.WorkerID, row.Role, row.BootGeneration)
		if err != nil {
			return recorderfleetauthority.BootstrapRecord{}, recorderfleet.ErrInventoryDrift
		}
		record.Identity = &identity
	}
	return record, nil
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
