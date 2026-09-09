package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func TestRecordingFleetAuthorityRepositoryPreservesBootstrapBinding(t *testing.T) {
	t.Parallel()
	request := postgresFleetBootstrapRequest()
	workerID := postgresFleetUUID(t, "55555555-5555-4555-8555-555555555555")
	queries := &recordingFleetAuthorityQueriesStub{reserveRow: sqlc.RecordingFleetNode{
		Environment: request.Key.Environment, Role: string(request.Key.Role), ProviderID: request.ProviderID,
		NodeName: request.NodeName, Region: request.Region, ReleaseID: request.ReleaseID,
		ImageDigest: request.ImageDigest, BootGeneration: int64(request.BootGeneration),
		InventoryDigest: request.InventoryDigest, WorkerID: workerID, State: "active",
	}}
	repository := NewRecordingFleetAuthorityRepository(queries)
	record, err := repository.ReserveBootstrap(t.Context(), request)
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if record.Request != request || record.Identity == nil || record.Identity.WorkerID != "55555555-5555-4555-8555-555555555555" || record.Identity.BootGeneration != request.BootGeneration {
		t.Fatalf("record = %#v", record)
	}
	if queries.reserveArg.ProviderID != request.ProviderID || queries.reserveArg.InventoryDigest != request.InventoryDigest {
		t.Fatalf("reserve params = %#v", queries.reserveArg)
	}
}

func TestRecordingFleetAuthorityRepositoryMapsBindingConflicts(t *testing.T) {
	t.Parallel()
	request := postgresFleetBootstrapRequest()
	for name, queryErr := range map[string]error{
		"immutable tuple mismatch": pgx.ErrNoRows,
		"worker identity reused":   &pgconn.PgError{Code: "23505"},
	} {
		t.Run(name, func(t *testing.T) {
			repository := NewRecordingFleetAuthorityRepository(&recordingFleetAuthorityQueriesStub{reserveErr: queryErr})
			_, err := repository.ReserveBootstrap(t.Context(), request)
			if !errors.Is(err, recorderfleet.ErrInventoryDrift) {
				t.Fatalf("error = %v", err)
			}
		})
	}
	queries := &recordingFleetAuthorityQueriesStub{activateErr: &pgconn.PgError{Code: "23505"}}
	repository := NewRecordingFleetAuthorityRepository(queries)
	_, err := repository.ActivateBootstrap(t.Context(), request, recorderfleet.NodeIdentity{
		ProviderID: request.ProviderID, WorkerID: "55555555-5555-4555-8555-555555555555",
		Role: request.Key.Role, BootGeneration: request.BootGeneration,
	})
	if !errors.Is(err, recorderfleet.ErrRoleFence) {
		t.Fatalf("activate error = %v", err)
	}
}

func TestRecordingFleetAuthorityRepositoryAbandonsExactRequest(t *testing.T) {
	t.Parallel()
	request := postgresFleetBootstrapRequest()
	queries := &recordingFleetAuthorityQueriesStub{abandonProviderID: request.ProviderID}
	repository := NewRecordingFleetAuthorityRepository(queries)
	if err := repository.AbandonBootstrap(t.Context(), request, time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("abandon: %v", err)
	}
	if queries.abandonArg.ProviderID != request.ProviderID || queries.abandonArg.NodeName != request.NodeName || queries.abandonArg.InventoryDigest != request.InventoryDigest || queries.abandonArg.BootGeneration != int64(request.BootGeneration) || !queries.abandonArg.RevokedAt.Valid {
		t.Fatalf("abandon params = %#v", queries.abandonArg)
	}
	queries.abandonErr = pgx.ErrNoRows
	if err := repository.AbandonBootstrap(t.Context(), request, time.Now()); !errors.Is(err, recorderfleet.ErrInventoryDrift) {
		t.Fatalf("mismatch error = %v", err)
	}
	queries.abandonErr = &pgconn.PgError{Code: "23505"}
	if err := repository.AbandonBootstrap(t.Context(), request, time.Now()); !errors.Is(err, recorderfleet.ErrInventoryDrift) {
		t.Fatalf("cross-role provider conflict error = %v", err)
	}
}

func TestRecordingFleetAuthorityRepositorySeparatesDrainFromClaimAuthorization(t *testing.T) {
	t.Parallel()
	workerID, _ := utilities.ParseID("55555555-5555-4555-8555-555555555555")
	identity := workeridentity.Identity{WorkerID: workerID, Role: workeridentity.RoleCapture}
	queries := &recordingFleetAuthorityQueriesStub{authorizeWorker: true, authorizeClaim: false}
	repository := NewRecordingFleetAuthorityRepository(queries)
	if err := repository.AuthorizeWorker(t.Context(), "staging", identity); err != nil {
		t.Fatalf("existing work authorization: %v", err)
	}
	if err := repository.AuthorizeWorkerClaim(t.Context(), "staging", identity); !errors.Is(err, recorderfleet.ErrAdmissionClosed) {
		t.Fatalf("claim authorization error = %v", err)
	}
}

type recordingFleetAuthorityQueriesStub struct {
	abandonArg        sqlc.AbandonRecordingFleetBootstrapParams
	abandonProviderID string
	abandonErr        error
	reserveArg        sqlc.ReserveRecordingFleetBootstrapParams
	reserveRow        sqlc.RecordingFleetNode
	reserveErr        error
	activateErr       error
	authorizeWorker   bool
	authorizeClaim    bool
}

func (s *recordingFleetAuthorityQueriesStub) AbandonRecordingFleetBootstrap(_ context.Context, arg sqlc.AbandonRecordingFleetBootstrapParams) (string, error) {
	s.abandonArg = arg
	return s.abandonProviderID, s.abandonErr
}

func (s *recordingFleetAuthorityQueriesStub) ActivateRecordingFleetBootstrap(context.Context, sqlc.ActivateRecordingFleetBootstrapParams) (sqlc.RecordingFleetNode, error) {
	return sqlc.RecordingFleetNode{}, s.activateErr
}

func (s *recordingFleetAuthorityQueriesStub) AuthorizeRecordingFleetWorker(context.Context, sqlc.AuthorizeRecordingFleetWorkerParams) (bool, error) {
	return s.authorizeWorker, nil
}

func (s *recordingFleetAuthorityQueriesStub) AuthorizeRecordingFleetWorkerClaim(context.Context, sqlc.AuthorizeRecordingFleetWorkerClaimParams) (bool, error) {
	return s.authorizeClaim, nil
}

func (s *recordingFleetAuthorityQueriesStub) CloseRecordingFleetNodeAdmission(context.Context, sqlc.CloseRecordingFleetNodeAdmissionParams) (string, error) {
	return "", errors.New("unexpected close")
}

func (s *recordingFleetAuthorityQueriesStub) GetRecordingFleetDemand(context.Context, sqlc.GetRecordingFleetDemandParams) (sqlc.GetRecordingFleetDemandRow, error) {
	return sqlc.GetRecordingFleetDemandRow{}, errors.New("unexpected demand")
}

func (s *recordingFleetAuthorityQueriesStub) ListRecordingFleetNodeObservations(context.Context, sqlc.ListRecordingFleetNodeObservationsParams) ([]sqlc.ListRecordingFleetNodeObservationsRow, error) {
	return nil, errors.New("unexpected observations")
}

func (s *recordingFleetAuthorityQueriesStub) PublishRecordingFleetPool(context.Context, sqlc.PublishRecordingFleetPoolParams) (string, error) {
	return "", errors.New("unexpected publish")
}

func (s *recordingFleetAuthorityQueriesStub) RecordRecordingFleetWorkerObservation(context.Context, sqlc.RecordRecordingFleetWorkerObservationParams) (sqlc.RecordRecordingFleetWorkerObservationRow, error) {
	return sqlc.RecordRecordingFleetWorkerObservationRow{}, errors.New("unexpected worker observation")
}

func (s *recordingFleetAuthorityQueriesStub) ReserveRecordingFleetBootstrap(_ context.Context, arg sqlc.ReserveRecordingFleetBootstrapParams) (sqlc.RecordingFleetNode, error) {
	s.reserveArg = arg
	return s.reserveRow, s.reserveErr
}

func (s *recordingFleetAuthorityQueriesStub) RevokeRecordingFleetNode(context.Context, sqlc.RevokeRecordingFleetNodeParams) (string, error) {
	return "", errors.New("unexpected revoke")
}

func postgresFleetBootstrapRequest() recorderfleet.BootstrapRequest {
	return recorderfleet.BootstrapRequest{
		Key:        recorderfleet.PoolKey{Environment: "staging", Role: workeridentity.RoleCapture},
		ProviderID: "provider-7", NodeName: "capture-7", Region: "fra1", ReleaseID: "release-7",
		ImageDigest:    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		BootGeneration: 7, InventoryDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	}
}

func postgresFleetUUID(t *testing.T, value string) pgtype.UUID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse id: %v", err)
	}
	return uuid(id)
}
