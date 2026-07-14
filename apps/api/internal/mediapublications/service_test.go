package mediapublications

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestRecordPublishedTracksMergesSnapshotAndEncodesPullReference(t *testing.T) {
	tenantID := testID(t, "11111111-1111-4111-8111-111111111111")
	sessionID := testID(t, "22222222-2222-4222-8222-222222222222")
	participantID := testID(t, "33333333-3333-4333-8333-333333333333")
	otherParticipantID := testID(t, "44444444-4444-4444-8444-444444444444")
	repository := &repositoryStub{observations: []provideroperations.Observation{{
		TenantID: tenantID, SessionID: sessionID, Incarnation: 1, Sequence: 4,
		Publications: []provideroperations.Publication{{ParticipantSessionID: otherParticipantID, Source: "microphone", Enabled: true, PublicationID: "other-session|other-track"}},
	}}}
	service := NewService(repository)

	err := service.RecordPublishedTracks(context.Background(), RecordInput{
		TenantID: tenantID, SessionID: sessionID, ParticipantSessionID: participantID, ConnectionID: "connection-123",
		Tracks: []PublishedTrack{{Source: "camera", TrackName: "camera-track"}, {Source: "microphone", TrackName: "microphone-track"}},
	})
	if err != nil {
		t.Fatalf("record tracks: %v", err)
	}
	if repository.appended.Sequence != 5 || len(repository.appended.Publications) != 3 {
		t.Fatalf("appended observation = %#v", repository.appended)
	}
	var found bool
	for _, publication := range repository.appended.Publications {
		if publication.ParticipantSessionID == participantID && publication.Source == "camera" {
			found = publication.PublicationID == "connection-123|camera-track" && publication.Enabled
		}
	}
	if !found {
		t.Fatalf("camera publication missing from %#v", repository.appended.Publications)
	}
}

func TestRecordPublishedTracksRejectsAmbiguousReferences(t *testing.T) {
	service := NewService(&repositoryStub{})
	err := service.RecordPublishedTracks(context.Background(), RecordInput{
		TenantID:             testID(t, "11111111-1111-4111-8111-111111111111"),
		SessionID:            testID(t, "22222222-2222-4222-8222-222222222222"),
		ParticipantSessionID: testID(t, "33333333-3333-4333-8333-333333333333"),
		ConnectionID:         "connection|invalid",
		Tracks:               []PublishedTrack{{Source: "camera", TrackName: "camera-track"}},
	})
	if !errors.Is(err, ErrInvalidPublication) {
		t.Fatalf("error = %v, want invalid publication", err)
	}
}

type repositoryStub struct {
	observations []provideroperations.Observation
	appended     provideroperations.ObservationInput
}

func (r *repositoryStub) AppendObservation(_ context.Context, input provideroperations.ObservationInput) (provideroperations.Observation, error) {
	r.appended = input
	return provideroperations.Observation{TenantID: input.TenantID, SessionID: input.SessionID, Incarnation: input.Incarnation, Sequence: input.Sequence, Publications: input.Publications}, nil
}

func (r *repositoryStub) ListObservations(_ context.Context, _, _ utilities.ID, _ *provideroperations.Cursor, _ int) (provideroperations.ObservationPage, error) {
	return provideroperations.ObservationPage{Observations: r.observations}, nil
}

func testID(t *testing.T, raw string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(raw)
	if err != nil {
		t.Fatalf("parse id: %v", err)
	}
	return id
}
