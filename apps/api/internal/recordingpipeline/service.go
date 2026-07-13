package recordingpipeline

import (
	"context"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type Service struct {
	repository Repository
	now        func() time.Time
}

func NewService(repository Repository) Service {
	return Service{repository: repository, now: time.Now}
}

func (s Service) Reserve(ctx context.Context, input ReservationInput) (Reservation, error) {
	input, _, err := BuildReservation(input, s.now().UTC())
	if err != nil {
		return Reservation{}, err
	}
	reservationID := input.ID
	if reservationID.IsZero() {
		reservationID, err = utilities.NewID()
		if err != nil {
			return Reservation{}, err
		}
	}
	input.ID = reservationID
	if input.RecordingID.IsZero() {
		input.RecordingID, err = utilities.NewID()
		if err != nil {
			return Reservation{}, err
		}
	}
	captureJobID, err := utilities.NewID()
	if err != nil {
		return Reservation{}, err
	}
	return s.repository.Reserve(ctx, input, captureJobID)
}

func (s Service) GetReservation(ctx context.Context, tenantID, reservationID utilities.ID) (Reservation, error) {
	if tenantID.IsZero() {
		return Reservation{}, ErrInvalidTenantID
	}
	if reservationID.IsZero() {
		return Reservation{}, ErrInvalidReservationID
	}
	return s.repository.GetReservation(ctx, tenantID, reservationID)
}

func (s Service) ExtendReservation(ctx context.Context, tenantID, reservationID utilities.ID, duration time.Duration, endsAt time.Time) (Reservation, error) {
	if tenantID.IsZero() {
		return Reservation{}, ErrInvalidTenantID
	}
	if reservationID.IsZero() {
		return Reservation{}, ErrInvalidReservationID
	}
	return s.repository.ExtendReservation(ctx, tenantID, reservationID, duration, endsAt)
}

func (s Service) ReleaseReservation(ctx context.Context, tenantID, reservationID utilities.ID, state ReservationState) (Reservation, error) {
	if tenantID.IsZero() {
		return Reservation{}, ErrInvalidTenantID
	}
	if reservationID.IsZero() {
		return Reservation{}, ErrInvalidReservationID
	}
	if state != ReservationStateReleased && state != ReservationStateExpired {
		return Reservation{}, ErrInvalidStateTransition
	}
	return s.repository.ReleaseReservation(ctx, tenantID, reservationID, state)
}

func (s Service) GetPipeline(ctx context.Context, tenantID, recordingID utilities.ID) (Pipeline, error) {
	if tenantID.IsZero() {
		return Pipeline{}, ErrInvalidTenantID
	}
	if recordingID.IsZero() {
		return Pipeline{}, ErrInvalidRecordingID
	}
	return s.repository.GetPipeline(ctx, tenantID, recordingID)
}

func (s Service) RecoverExpired(ctx context.Context) ([]Job, error) {
	return s.repository.RecoverExpired(ctx)
}

func (s Service) ExpireReservations(ctx context.Context, now time.Time) ([]Reservation, error) {
	if now.IsZero() {
		now = s.now().UTC()
	}
	return s.repository.ExpireReservations(ctx, now)
}

func (s Service) ListDeadLetters(ctx context.Context, tenantID utilities.ID, limit int) ([]Job, error) {
	if tenantID.IsZero() {
		return nil, ErrInvalidTenantID
	}
	return s.repository.ListDeadLetters(ctx, tenantID, limit)
}

func (s Service) ListForReconciliation(ctx context.Context, query ReconciliationQuery) ([]Job, error) {
	if query.Limit < 0 {
		return nil, ErrInvalidJobID
	}
	return s.repository.ListForReconciliation(ctx, query)
}

func (s Service) UpsertPoolHealth(ctx context.Context, health PoolHealth) (PoolHealth, error) {
	if err := ValidatePoolHealth(health); err != nil {
		return PoolHealth{}, err
	}
	if health.ObservedAt.IsZero() {
		health.ObservedAt = s.now().UTC()
	}
	return s.repository.UpsertPoolHealth(ctx, health)
}

func (s Service) GetPoolHealth(ctx context.Context, role PoolRole) (PoolHealth, error) {
	if role != PoolRoleCapture && role != PoolRoleRender {
		return PoolHealth{}, ErrInvalidJobID
	}
	return s.repository.GetPoolHealth(ctx, role)
}

func (s Service) Claim(ctx context.Context, input ClaimInput) (Job, error) {
	if input.Kind != JobKindCapture && input.Kind != JobKindRender {
		return Job{}, ErrInvalidJobID
	}
	if input.LeaseFor <= 0 || input.LeaseToken == "" || input.Owner == "" {
		return Job{}, ErrInvalidLease
	}
	return s.repository.Claim(ctx, input)
}

func (s Service) Heartbeat(ctx context.Context, input LeaseInput) (Job, error) {
	if err := ValidateLeaseInput(input); err != nil {
		return Job{}, err
	}
	return s.repository.Heartbeat(ctx, input)
}

func (s Service) Complete(ctx context.Context, input LeaseInput) (Job, error) {
	if err := ValidateLeaseInput(input); err != nil {
		return Job{}, err
	}
	return s.repository.Complete(ctx, input)
}

func (s Service) CompleteCapture(ctx context.Context, input LeaseInput) (Job, error) {
	if err := ValidateLeaseInput(input); err != nil {
		return Job{}, err
	}
	renderJobID, err := utilities.NewID()
	if err != nil {
		return Job{}, err
	}
	return s.repository.CompleteCapture(ctx, input, renderJobID)
}

func (s Service) Fail(ctx context.Context, input FailureInput) (Job, error) {
	if err := ValidateLeaseInput(input.LeaseInput); err != nil {
		return Job{}, err
	}
	if input.AvailableAt.IsZero() {
		input.AvailableAt = s.now().UTC()
	}
	return s.repository.Fail(ctx, input)
}

func (s Service) InsertBundle(ctx context.Context, input BundleInput) (Bundle, error) {
	if err := ValidateBundleInput(input); err != nil {
		return Bundle{}, err
	}
	return s.repository.InsertBundle(ctx, input)
}

func (s Service) CommitArtifact(ctx context.Context, input ArtifactInput) (Artifact, error) {
	if err := ValidateArtifactInput(input); err != nil {
		return Artifact{}, err
	}
	return s.repository.CommitArtifact(ctx, input)
}
