package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleetauthority"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func (r RecordingFleetAuthorityRepository) RecordWorkerObservation(ctx context.Context, environment string, observation recorderfleetauthority.WorkerObservation) (recorderfleet.NodeObservation, error) {
	if r.queries == nil {
		return recorderfleet.NodeObservation{}, recorderfleet.ErrProviderUnavailable
	}
	if observation.ReadyCapacity > math.MaxInt32 {
		return recorderfleet.NodeObservation{}, recorderfleet.ErrInventoryDrift
	}
	var resources []byte
	var peakRSS pgtype.Int8
	if observation.Resources != nil {
		var err error
		resources, err = json.Marshal(observation.Resources)
		if err != nil {
			return recorderfleet.NodeObservation{}, fmt.Errorf("encode worker resources: %w", err)
		}
		peakRSS = pgtype.Int8{Int64: observation.Resources.PeakRSSBytes, Valid: true}
	}
	row, err := r.queries.RecordRecordingFleetWorkerObservation(ctx, sqlc.RecordRecordingFleetWorkerObservationParams{
		Ready: observation.Ready, AdmissionOpen: observation.AdmissionOpen, ReadyCapacity: int32(observation.ReadyCapacity),
		ResourcesLatest: resources, PeakRssBytes: peakRSS,
		Environment: environment, Role: string(observation.Identity.Role), WorkerID: uuid(observation.Identity.WorkerID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		colocated, colocatedErr := r.queries.RecordRecordingColocatedWorkerObservation(ctx, sqlc.RecordRecordingColocatedWorkerObservationParams{
			Ready: observation.Ready, AdmissionOpen: observation.AdmissionOpen, ReadyCapacity: int32(observation.ReadyCapacity),
			ResourcesLatest: resources, PeakRssBytes: peakRSS,
			Environment: environment, Role: string(observation.Identity.Role), WorkerID: uuid(observation.Identity.WorkerID),
		})
		if errors.Is(colocatedErr, pgx.ErrNoRows) {
			return recorderfleet.NodeObservation{}, recorderfleet.ErrNodeNotFound
		}
		if colocatedErr != nil {
			return recorderfleet.NodeObservation{}, fmt.Errorf("record colocated capture worker observation: %w", colocatedErr)
		}
		row, err = sqlc.RecordRecordingFleetWorkerObservationRow(colocated), nil
	}
	if err != nil {
		return recorderfleet.NodeObservation{}, fmt.Errorf("record recording fleet worker observation: %w", err)
	}
	identity, err := recordingFleetIdentity(row.ProviderID, row.WorkerID, row.Role, row.BootGeneration)
	if err != nil || !row.ObservedAt.Valid {
		return recorderfleet.NodeObservation{}, recorderfleet.ErrInventoryDrift
	}
	return recorderfleet.NodeObservation{
		Identity: identity, NodeName: row.NodeName, CurrentJobID: idString(row.CurrentJobID), Ready: row.Ready, AdmissionOpen: row.AdmissionOpen,
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
	claim, err := r.queries.AuthorizeRecordingFleetWorkerClaim(ctx, sqlc.AuthorizeRecordingFleetWorkerClaimParams{
		Environment: environment, Role: string(identity.Role), WorkerID: uuid(identity.WorkerID), ColocatedEnabled: r.colocatedGrace > 0,
	})
	if err != nil {
		return fmt.Errorf("authorize recording fleet worker claim: %w", err)
	}
	if claim.AdmissionClosed {
		return recorderfleet.ErrAdmissionClosed
	}
	if !claim.Authorized {
		return recorderfleet.ErrNodeNotFound
	}
	return nil
}

// EnsureColocatedCaptureWorkers registers the worker beside each named own-SFU node. Its ID is
// derived from the node, and an existing or revoked registration stays as it is.
func (r RecordingFleetAuthorityRepository) EnsureColocatedCaptureWorkers(ctx context.Context, environment string, sfuNodes []string) error {
	if r.queries == nil {
		return recorderfleet.ErrProviderUnavailable
	}
	for _, node := range sfuNodes {
		err := r.queries.EnsureRecordingColocatedCaptureWorker(ctx, sqlc.EnsureRecordingColocatedCaptureWorkerParams{
			Environment: environment, SfuNode: node, WorkerID: uuid(workeridentity.ColocatedWorkerID(environment, node)),
		})
		if err != nil {
			return fmt.Errorf("register colocated capture worker for SFU node %q: %w", node, err)
		}
	}
	return nil
}

func colocatedGraceSeconds(grace time.Duration) int32 {
	if grace <= 0 {
		return 0
	}
	return max(1, int32(grace/time.Second))
}
