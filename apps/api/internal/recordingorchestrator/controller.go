package recordingorchestrator

import (
	"context"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/providerbridge"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// Controller translates the private provider effect into durable Recording
// aggregate commands. It never allocates a second recording identity.
type Controller struct {
	pipeline recordingpipeline.Service
}

func NewController(pipeline recordingpipeline.Service) Controller {
	return Controller{pipeline: pipeline}
}

var _ providerbridge.RecordingController = Controller{}

func (c Controller) Start(ctx context.Context, input provideroperations.OperationInput) error {
	reservation := input.RecordingReservation
	if reservation == nil {
		return provideroperations.ErrInvalidRecordingReservation
	}
	if err := reservation.Validate(); err != nil {
		return err
	}
	_, err := c.pipeline.Materialize(ctx, recordingpipeline.ReservationInput{
		TenantID:              input.TenantID,
		SpaceID:               reservation.SpaceID,
		EpisodeID:             input.EpisodeID,
		RecordingID:           input.RecordingID,
		IdempotencyKey:        input.OperationID,
		PolicySnapshotVersion: reservation.PolicySnapshotVersion,
		ParticipantCount:      reservation.ParticipantCount,
		MaxDuration:           time.Duration(reservation.MaxDurationSeconds) * time.Second,
		InputBitrateBPS:       reservation.InputBitrateBPS,
	})
	return err
}

func (c Controller) Stop(ctx context.Context, input provideroperations.OperationInput) error {
	operationID, err := utilities.ParseID(input.OperationID)
	if err != nil {
		return provideroperations.ErrInvalidOperationID
	}
	_, err = c.pipeline.RequestStop(ctx, input.TenantID, input.EpisodeID, input.RecordingID, operationID)
	return err
}
