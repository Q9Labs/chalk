package postgres

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleetauthority"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func (r RecordingFleetAuthorityRepository) AbandonBootstrap(ctx context.Context, request recorderfleet.BootstrapRequest, revokedAt time.Time) error {
	if r.queries == nil {
		return recorderfleet.ErrProviderUnavailable
	}
	bootGeneration, ok := recordingFleetGeneration(request.BootGeneration)
	if !ok {
		return recorderfleet.ErrInventoryDrift
	}
	providerID, err := r.queries.AbandonRecordingFleetBootstrap(ctx, sqlc.AbandonRecordingFleetBootstrapParams{
		Environment: request.Key.Environment, Role: string(request.Key.Role), ProviderID: request.ProviderID,
		NodeName: request.NodeName, Region: request.Region, ReleaseID: request.ReleaseID,
		ImageDigest: request.ImageDigest, BootGeneration: bootGeneration, InventoryDigest: request.InventoryDigest,
		RevokedAt: timestamptzValue(revokedAt),
	})
	if errors.Is(err, pgx.ErrNoRows) || isUniqueViolation(err) {
		return recorderfleet.ErrInventoryDrift
	}
	if err != nil {
		return fmt.Errorf("abandon recording fleet bootstrap: %w", err)
	}
	if providerID != request.ProviderID {
		return recorderfleet.ErrInventoryDrift
	}
	return nil
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
	if isUniqueViolation(err) {
		return recorderfleet.ErrRoleFence
	}
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
