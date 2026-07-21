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

	references, err := service.RecordPublishedTracks(context.Background(), RecordInput{
		TenantID: tenantID, SessionID: sessionID, ParticipantSessionID: participantID, ParticipantGeneration: 7, ConnectionID: "connection-123",
		Tracks: []PublishedTrack{{Source: "camera", MID: "camera-mid", TrackName: "camera-track"}, {Source: "microphone", MID: "microphone-mid", TrackName: "microphone-track"}},
	})
	if err != nil {
		t.Fatalf("record tracks: %v", err)
	}
	if repository.appended.Sequence != 5 || len(repository.appended.Publications) != 3 {
		t.Fatalf("appended observation = %#v", repository.appended)
	}
	if len(references) != 2 || references[0].Source != "camera" || references[0].MID != "camera-mid" || references[0].PublicationID == "" {
		t.Fatalf("published references = %#v, want exact camera and microphone references", references)
	}
	var found bool
	for _, publication := range repository.appended.Publications {
		if publication.ParticipantSessionID == participantID && publication.Source == "camera" {
			reference, parseErr := ParseReference(publication.PublicationID)
			found = parseErr == nil && publication.PublicationID == references[0].PublicationID && reference == (Reference{Version: 1, ConnectionID: "connection-123", MID: "camera-mid", TrackName: "camera-track", ParticipantGeneration: 7, HasMID: true, HasParticipantGeneration: true}) && publication.Enabled
		}
	}
	if !found {
		t.Fatalf("camera publication missing from %#v", repository.appended.Publications)
	}
}

func TestRecordPublishedTracksRejectsAmbiguousReferences(t *testing.T) {
	service := NewService(&repositoryStub{})
	_, err := service.RecordPublishedTracks(context.Background(), RecordInput{
		TenantID:              testID(t, "11111111-1111-4111-8111-111111111111"),
		SessionID:             testID(t, "22222222-2222-4222-8222-222222222222"),
		ParticipantSessionID:  testID(t, "33333333-3333-4333-8333-333333333333"),
		ParticipantGeneration: 1,
		ConnectionID:          "connection|invalid",
		Tracks:                []PublishedTrack{{Source: "camera", MID: "camera-mid", TrackName: "camera-track"}},
	})
	if !errors.Is(err, ErrInvalidPublication) {
		t.Fatalf("error = %v, want invalid publication", err)
	}
}

func TestRecordPublishedTracksRequiresGenerationAndMID(t *testing.T) {
	tenantID := testID(t, "11111111-1111-4111-8111-111111111111")
	sessionID := testID(t, "22222222-2222-4222-8222-222222222222")
	participantID := testID(t, "33333333-3333-4333-8333-333333333333")
	for _, test := range []struct {
		name       string
		generation int64
		mid        string
	}{
		{name: "missing generation", mid: "camera-mid"},
		{name: "missing MID", generation: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := NewService(&repositoryStub{})
			_, err := service.RecordPublishedTracks(context.Background(), RecordInput{
				TenantID:              tenantID,
				SessionID:             sessionID,
				ParticipantSessionID:  participantID,
				ParticipantGeneration: test.generation,
				ConnectionID:          "connection-123",
				Tracks:                []PublishedTrack{{Source: "camera", MID: test.mid, TrackName: "camera-track"}},
			})
			if !errors.Is(err, ErrInvalidPublication) {
				t.Fatalf("error = %v, want invalid publication", err)
			}
		})
	}
}

func TestRecordClosedPublicationPersistsDisabledSnapshot(t *testing.T) {
	tenantID := testID(t, "11111111-1111-4111-8111-111111111111")
	sessionID := testID(t, "22222222-2222-4222-8222-222222222222")
	participantID := testID(t, "33333333-3333-4333-8333-333333333333")
	repository := &repositoryStub{}
	service := NewService(repository)

	_, err := service.RecordPublishedTracks(context.Background(), RecordInput{
		TenantID: tenantID, SessionID: sessionID, ParticipantSessionID: participantID, ParticipantGeneration: 1, ConnectionID: "connection-123",
		Tracks: []PublishedTrack{{Source: "camera", MID: "camera-mid", TrackName: "camera-track"}},
	})
	if err != nil {
		t.Fatalf("record tracks: %v", err)
	}
	publicationID := repository.appended.Publications[0].PublicationID
	err = service.RecordClosedPublication(context.Background(), CloseInput{
		TenantID: tenantID, SessionID: sessionID, ParticipantSessionID: participantID,
		ParticipantGeneration: 1, ConnectionID: "connection-123", MID: "camera-mid", Source: "camera", PublicationID: publicationID,
	})
	if err != nil {
		t.Fatalf("record closed publication: %v", err)
	}

	snapshot, err := service.Latest(context.Background(), tenantID, sessionID)
	if err != nil {
		t.Fatalf("latest: %v", err)
	}
	if snapshot.Incarnation != 1 || snapshot.Sequence != 2 || len(snapshot.Publications) != 1 {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	publication := snapshot.Publications[0]
	if publication.ParticipantSessionID != participantID || publication.Source != "camera" || publication.Enabled || publication.PublicationID != "" {
		t.Fatalf("closed publication = %#v", publication)
	}
}

func TestRecordClosedPublicationIsIdempotent(t *testing.T) {
	tenantID := testID(t, "11111111-1111-4111-8111-111111111111")
	sessionID := testID(t, "22222222-2222-4222-8222-222222222222")
	participantID := testID(t, "33333333-3333-4333-8333-333333333333")
	publicationID := encodeReference("connection-123", "microphone-mid", "microphone-track", 3)
	repository := &repositoryStub{observations: []provideroperations.Observation{{
		TenantID: tenantID, SessionID: sessionID, Incarnation: 7, Sequence: 41,
		Publications: []provideroperations.Publication{{ParticipantSessionID: participantID, Source: "microphone", Enabled: true, PublicationID: publicationID}},
	}}}
	service := NewService(repository)
	input := CloseInput{
		TenantID: tenantID, SessionID: sessionID, ParticipantSessionID: participantID,
		ParticipantGeneration: 3, ConnectionID: "connection-123", MID: "microphone-mid", Source: "microphone", PublicationID: publicationID,
	}

	decision, err := service.PrepareClose(context.Background(), input)
	if err != nil || !decision.ProviderCloseRequired {
		t.Fatalf("prepare first close = %#v, %v; want provider required", decision, err)
	}
	if err := service.RecordClosedPublication(context.Background(), input); err != nil {
		t.Fatalf("first close: %v", err)
	}
	if err := service.RecordClosedPublication(context.Background(), input); err != nil {
		t.Fatalf("duplicate close: %v", err)
	}
	decision, err = service.PrepareClose(context.Background(), input)
	if err != nil || decision.ProviderCloseRequired {
		t.Fatalf("prepare duplicate close = %#v, %v; want already satisfied", decision, err)
	}
	if len(repository.appendedInputs) != 1 {
		t.Fatalf("append count = %d, want 1", len(repository.appendedInputs))
	}
	if repository.appended.Incarnation != 7 || repository.appended.Sequence != 42 {
		t.Fatalf("close cursor = (%d,%d), want (7,42)", repository.appended.Incarnation, repository.appended.Sequence)
	}
}

func TestPrepareCloseRejectsStaleReferenceBeforeProviderAndPreservesReplacement(t *testing.T) {
	tenantID := testID(t, "11111111-1111-4111-8111-111111111111")
	sessionID := testID(t, "22222222-2222-4222-8222-222222222222")
	participantID := testID(t, "33333333-3333-4333-8333-333333333333")
	replacementID := encodeReference("connection-new", "screen-mid", "screen-new", 8)
	staleID := encodeReference("connection-old", "screen-mid", "screen-old", 7)
	repository := &repositoryStub{observations: []provideroperations.Observation{{
		TenantID: tenantID, SessionID: sessionID, Incarnation: 1, Sequence: 2,
		Publications: []provideroperations.Publication{{ParticipantSessionID: participantID, Source: "screen", Enabled: true, PublicationID: replacementID}},
	}}}
	service := NewService(repository)

	input := CloseInput{
		TenantID: tenantID, SessionID: sessionID, ParticipantSessionID: participantID,
		ParticipantGeneration: 7, ConnectionID: "connection-old", MID: "screen-mid", Source: "screen", PublicationID: staleID,
	}
	decision, err := service.PrepareClose(context.Background(), input)
	if !errors.Is(err, ErrInvalidPublication) || decision.ProviderCloseRequired {
		t.Fatalf("prepare stale close = %#v, %v; want rejection before provider", decision, err)
	}
	if err := service.RecordClosedPublication(context.Background(), input); !errors.Is(err, ErrInvalidPublication) {
		t.Fatalf("record stale close error = %v, want invalid publication", err)
	}
	if len(repository.appendedInputs) != 0 {
		t.Fatalf("stale close appended %#v", repository.appendedInputs)
	}

	snapshot, err := service.Latest(context.Background(), tenantID, sessionID)
	if err != nil {
		t.Fatalf("latest: %v", err)
	}
	publication := snapshot.Publications[0]
	if !publication.Enabled || publication.PublicationID != replacementID || snapshot.Sequence != 2 {
		t.Fatalf("replacement changed by stale close: %#v", snapshot)
	}
}

func TestRecordClosedPublicationCanRetryRegistryAfterProviderSuccess(t *testing.T) {
	tenantID := testID(t, "11111111-1111-4111-8111-111111111111")
	sessionID := testID(t, "22222222-2222-4222-8222-222222222222")
	participantID := testID(t, "33333333-3333-4333-8333-333333333333")
	publicationID := encodeReference("connection-123", "camera-mid", "camera-track", 4)
	repositoryFailure := errors.New("database unavailable")
	repository := &repositoryStub{
		observations: []provideroperations.Observation{{
			TenantID: tenantID, SessionID: sessionID, Incarnation: 3, Sequence: 8,
			Publications: []provideroperations.Publication{{ParticipantSessionID: participantID, Source: "camera", Enabled: true, PublicationID: publicationID}},
		}},
		appendErrors: []error{repositoryFailure},
	}
	service := NewService(repository)
	input := CloseInput{
		TenantID: tenantID, SessionID: sessionID, ParticipantSessionID: participantID,
		ParticipantGeneration: 4, ConnectionID: "connection-123", MID: "camera-mid", Source: "camera", PublicationID: publicationID,
	}

	if err := service.RecordClosedPublication(context.Background(), input); !errors.Is(err, repositoryFailure) {
		t.Fatalf("first close error = %v, want repository failure", err)
	}
	if err := service.RecordClosedPublication(context.Background(), input); err != nil {
		t.Fatalf("retried close: %v", err)
	}
	if len(repository.appendedInputs) != 1 || repository.appended.Sequence != 9 || repository.appended.Publications[0].Enabled {
		t.Fatalf("retry append = %#v", repository.appendedInputs)
	}
}

func TestRecordClosedPublicationRejectsMismatchedConnection(t *testing.T) {
	service := NewService(&repositoryStub{})
	err := service.RecordClosedPublication(context.Background(), CloseInput{
		TenantID:              testID(t, "11111111-1111-4111-8111-111111111111"),
		SessionID:             testID(t, "22222222-2222-4222-8222-222222222222"),
		ParticipantSessionID:  testID(t, "33333333-3333-4333-8333-333333333333"),
		ParticipantGeneration: 1,
		ConnectionID:          "connection-new",
		MID:                   "camera-mid",
		Source:                "camera",
		PublicationID:         encodeReference("connection-old", "camera-mid", "camera-track", 1),
	})
	if !errors.Is(err, ErrInvalidPublication) {
		t.Fatalf("error = %v, want invalid publication", err)
	}
}

func TestRecordClosedPublicationRejectsMismatchedMID(t *testing.T) {
	service := NewService(&repositoryStub{})
	err := service.RecordClosedPublication(context.Background(), CloseInput{
		TenantID:              testID(t, "11111111-1111-4111-8111-111111111111"),
		SessionID:             testID(t, "22222222-2222-4222-8222-222222222222"),
		ParticipantSessionID:  testID(t, "33333333-3333-4333-8333-333333333333"),
		ParticipantGeneration: 1,
		ConnectionID:          "connection-123",
		MID:                   "other-mid",
		Source:                "camera",
		PublicationID:         encodeReference("connection-123", "camera-mid", "camera-track", 1),
	})
	if !errors.Is(err, ErrInvalidPublication) {
		t.Fatalf("error = %v, want invalid publication", err)
	}
}

func TestRecordClosedPublicationRejectsLegacyAndMismatchedGenerationReferences(t *testing.T) {
	base := CloseInput{
		TenantID: testID(t, "11111111-1111-4111-8111-111111111111"), SessionID: testID(t, "22222222-2222-4222-8222-222222222222"),
		ParticipantSessionID: testID(t, "33333333-3333-4333-8333-333333333333"), ParticipantGeneration: 8,
		ConnectionID: "connection-123", MID: "camera-mid", Source: "camera",
	}
	for _, test := range []struct {
		name          string
		publicationID string
	}{
		{name: "legacy", publicationID: "connection-123|camera-track"},
		{name: "generation", publicationID: encodeReference("connection-123", "camera-mid", "camera-track", 7)},
	} {
		t.Run(test.name, func(t *testing.T) {
			input := base
			input.PublicationID = test.publicationID
			if err := NewService(&repositoryStub{}).RecordClosedPublication(context.Background(), input); !errors.Is(err, ErrInvalidPublication) {
				t.Fatalf("error = %v, want invalid publication", err)
			}
		})
	}
}

type repositoryStub struct {
	observations   []provideroperations.Observation
	appended       provideroperations.ObservationInput
	appendedInputs []provideroperations.ObservationInput
	appendErrors   []error
}

func (r *repositoryStub) AppendObservation(_ context.Context, input provideroperations.ObservationInput) (provideroperations.Observation, error) {
	if len(r.appendErrors) > 0 {
		err := r.appendErrors[0]
		r.appendErrors = r.appendErrors[1:]
		return provideroperations.Observation{}, err
	}
	r.appended = input
	r.appendedInputs = append(r.appendedInputs, input)
	observation := provideroperations.Observation{TenantID: input.TenantID, SessionID: input.SessionID, Incarnation: input.Incarnation, Sequence: input.Sequence, Publications: input.Publications}
	r.observations = append(r.observations, observation)
	return observation, nil
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
