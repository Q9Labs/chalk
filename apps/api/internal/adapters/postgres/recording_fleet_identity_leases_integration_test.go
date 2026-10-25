package postgres_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func TestFleetIdentityLeaseReadFencesEveryBinding(t *testing.T) {
	tx, fixture := newAllocationCleanupFixture(t, false, "transcription")
	defer func() { _ = tx.Rollback(context.Background()) }()
	repository := postgres.NewRecordingFleetAuthorityRepository(sqlc.New(tx))
	workerID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	identity := recorderfleet.NodeIdentity{ProviderID: "fenced", WorkerID: workerID.String(), Role: workeridentity.RoleRender, BootGeneration: 7}
	config := fleetRecoveryConfig(identity.Role)
	execCleanupFixture(t, tx, `update recording_jobs set lease_owner=$2,lease_expires_at=clock_timestamp()+interval '10 minutes' where id=$1`, fixture.jobID.Bytes(), identity.WorkerID)
	for _, skew := range []time.Duration{-time.Hour, time.Hour} {
		observation, err := repository.ObserveIdentity(t.Context(), config.Key.Environment, identity, time.Now().Add(skew))
		if err != nil || observation.ActiveLeases != 1 || !observation.IdentityAbsent || observation.IdentityRevoked {
			t.Fatalf("lost row hid live lease: %+v %v", observation, err)
		}
	}
	// Restoring the fence records a tombstone, never an active worker row.
	if err := repository.MarkRevoked(t.Context(), config.Key.Environment, identity, time.Now()); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"worker", "provider", "role", "generation", "environment"} {
		t.Run(field, func(t *testing.T) {
			conflict := identity
			environment := config.Key.Environment
			switch field {
			case "worker":
				conflict.WorkerID = "55555555-5555-4555-8555-555555555555"
			case "provider":
				conflict.ProviderID = "other"
			case "role":
				conflict.Role = workeridentity.RoleCapture
			case "generation":
				conflict.BootGeneration++
			case "environment":
				environment = "other"
			}
			if _, err := repository.ObserveIdentity(t.Context(), environment, conflict, time.Now()); !errors.Is(err, recorderfleet.ErrRoleFence) {
				t.Fatalf("%s conflict not fenced: %v", field, err)
			}
		})
	}
	observation, err := repository.ObserveIdentity(t.Context(), config.Key.Environment, identity, time.Now())
	if err != nil || observation.ActiveLeases != 1 || observation.IdentityAbsent || !observation.IdentityRevoked {
		t.Fatalf("tombstone hid live lease: %+v %v", observation, err)
	}
}
