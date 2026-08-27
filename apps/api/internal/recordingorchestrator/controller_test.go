package recordingorchestrator

import (
	"context"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestStartMaterializesExactRecordingIdentityAndReservation(t *testing.T) {
	repository := &pipelineRepositoryStub{}
	controller := NewController(recordingpipeline.NewService(repository))
	input := provideroperations.OperationInput{
		OperationID: "11111111-1111-4111-8111-111111111111",
		Effect:      provideroperations.EffectStartRecording,
		TenantID:    testControllerID(t, "22222222-2222-4222-8222-222222222222"),
		EpisodeID:   testControllerID(t, "33333333-3333-4333-8333-333333333333"),
		RecordingID: testControllerID(t, "44444444-4444-4444-8444-444444444444"),
		RecordingReservation: &provideroperations.RecordingReservation{
			SpaceID:               testControllerID(t, "55555555-5555-4555-8555-555555555555"),
			ParticipantCount:      10,
			MaxDurationSeconds:    179,
			InputBitrateBPS:       4_000_000,
			PolicySnapshotVersion: "episode_config.v2",
		},
	}

	if err := controller.Start(context.Background(), input); err != nil {
		t.Fatalf("start recording: %v", err)
	}
	if repository.input.RecordingID != input.RecordingID || repository.input.IdempotencyKey != input.OperationID {
		t.Fatalf("materialized input = %#v", repository.input)
	}
	if repository.input.SpaceID != input.RecordingReservation.SpaceID ||
		repository.input.PolicySnapshotVersion != input.RecordingReservation.PolicySnapshotVersion ||
		repository.input.ParticipantCount != 10 ||
		repository.input.MaxDuration != 179*time.Second ||
		repository.input.InputBitrateBPS != 4_000_000 {
		t.Fatalf("materialized reservation = %#v", repository.input)
	}
}

func TestStopReservesOperationIdentity(t *testing.T) {
	repository := &pipelineRepositoryStub{}
	controller := NewController(recordingpipeline.NewService(repository))
	input := provideroperations.OperationInput{
		OperationID: "66666666-6666-4666-8666-666666666666",
		Effect:      provideroperations.EffectStopRecording,
		TenantID:    testControllerID(t, "22222222-2222-4222-8222-222222222222"),
		EpisodeID:   testControllerID(t, "33333333-3333-4333-8333-333333333333"),
		RecordingID: testControllerID(t, "44444444-4444-4444-8444-444444444444"),
	}

	if err := controller.Stop(context.Background(), input); err != nil {
		t.Fatalf("stop recording: %v", err)
	}
	if repository.stopOperationID.String() != input.OperationID || repository.stopEpisodeID != input.EpisodeID || repository.stopRecordingID != input.RecordingID {
		t.Fatalf("stop request = operation %s recording %s", repository.stopOperationID, repository.stopRecordingID)
	}
}

type pipelineRepositoryStub struct {
	recordingpipeline.Repository
	input           recordingpipeline.ReservationInput
	stopOperationID utilities.ID
	stopEpisodeID   utilities.ID
	stopRecordingID utilities.ID
}

func (r *pipelineRepositoryStub) Reserve(_ context.Context, input recordingpipeline.ReservationInput, _ utilities.ID) (recordingpipeline.Reservation, error) {
	r.input = input
	return recordingpipeline.Reservation{RecordingID: input.RecordingID}, nil
}

func (r *pipelineRepositoryStub) RequestStop(_ context.Context, _, episodeID, recordingID, operationID utilities.ID) (recordingpipeline.Pipeline, error) {
	r.stopEpisodeID = episodeID
	r.stopRecordingID = recordingID
	r.stopOperationID = operationID
	return recordingpipeline.Pipeline{RecordingID: recordingID, StopOperationID: &operationID}, nil
}

func testControllerID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse id: %v", err)
	}
	return id
}
