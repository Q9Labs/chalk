package mediapublications

import (
	"context"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestObserveRemoteTracksRequiresRepeatedAgeBoundedAbsence(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	repository := &reconciliationRepositoryStub{}
	service := newService(repository, func() time.Time { return now })
	tenantID, episodeID, participantID, identity := publishRemoteObservationFixture(t, service, repository)
	input := RemoteTrackObservationInput{TenantID: tenantID, EpisodeID: episodeID, Requested: []RemoteTrackIdentity{identity}, Missing: []RemoteTrackIdentity{identity}}

	for _, advance := range []time.Duration{0, 4 * time.Second, 4 * time.Second, 4 * time.Second} {
		now = now.Add(advance)
		if err := service.ObserveRemoteTracks(context.Background(), input); err != nil {
			t.Fatalf("observe absence before grace: %v", err)
		}
	}
	if len(repository.appendedInputs) != 1 {
		t.Fatalf("append count before grace = %d, want publication only", len(repository.appendedInputs))
	}
	now = now.Add(4 * time.Second)
	if err := service.ObserveRemoteTracks(context.Background(), input); err != nil {
		t.Fatalf("observe confirmed absence: %v", err)
	}

	assertPublicationEnabled(t, repository.appended.Publications, participantID, "camera", false)
}

func TestObserveRemoteTracksCountsConcurrentMissesAsOneEvidenceWave(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	repository := &reconciliationRepositoryStub{}
	service := newService(repository, func() time.Time { return now })
	tenantID, episodeID, participantID, identity := publishRemoteObservationFixture(t, service, repository)
	input := RemoteTrackObservationInput{TenantID: tenantID, EpisodeID: episodeID, Requested: []RemoteTrackIdentity{identity}, Missing: []RemoteTrackIdentity{identity}}

	for index := 0; index < 4; index++ {
		if err := service.ObserveRemoteTracks(context.Background(), input); err != nil {
			t.Fatalf("observe same evidence wave %d: %v", index+1, err)
		}
	}
	for _, advance := range []time.Duration{4 * time.Second, 4 * time.Second, 8 * time.Second} {
		now = now.Add(advance)
		if err := service.ObserveRemoteTracks(context.Background(), input); err != nil {
			t.Fatalf("observe spaced evidence: %v", err)
		}
	}

	assertPublicationEnabled(t, repository.appended.Publications, participantID, "camera", false)
}

func TestObserveRemoteTracksFrequentPollingStillAccumulatesSpacedEvidence(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	repository := &reconciliationRepositoryStub{}
	service := newService(repository, func() time.Time { return now })
	tenantID, episodeID, participantID, identity := publishRemoteObservationFixture(t, service, repository)
	input := RemoteTrackObservationInput{TenantID: tenantID, EpisodeID: episodeID, Requested: []RemoteTrackIdentity{identity}, Missing: []RemoteTrackIdentity{identity}}
	for index := 0; index <= 16; index++ {
		if err := service.ObserveRemoteTracks(context.Background(), input); err != nil {
			t.Fatalf("observe at second %d: %v", index, err)
		}
		now = now.Add(time.Second)
	}
	assertPublicationEnabled(t, repository.appended.Publications, participantID, "camera", false)
}

func TestObserveRemoteTracksPresenceResetsAbsenceEvidence(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	repository := &reconciliationRepositoryStub{}
	service := newService(repository, func() time.Time { return now })
	tenantID, episodeID, participantID, identity := publishRemoteObservationFixture(t, service, repository)
	missing := RemoteTrackObservationInput{TenantID: tenantID, EpisodeID: episodeID, Requested: []RemoteTrackIdentity{identity}, Missing: []RemoteTrackIdentity{identity}}

	if err := service.ObserveRemoteTracks(context.Background(), missing); err != nil {
		t.Fatalf("observe first absence: %v", err)
	}
	now = now.Add(4 * time.Second)
	if err := service.ObserveRemoteTracks(context.Background(), missing); err != nil {
		t.Fatalf("observe second absence: %v", err)
	}
	now = now.Add(time.Second)
	present := missing
	present.Missing = nil
	if err := service.ObserveRemoteTracks(context.Background(), present); err != nil {
		t.Fatalf("observe presence: %v", err)
	}
	now = now.Add(20 * time.Second)
	if err := service.ObserveRemoteTracks(context.Background(), missing); err != nil {
		t.Fatalf("observe absence after reset: %v", err)
	}

	if len(repository.appendedInputs) != 1 {
		t.Fatalf("append count after reset = %d, want publication only", len(repository.appendedInputs))
	}
	assertPublicationEnabled(t, repository.appended.Publications, participantID, "camera", true)
}

func TestObserveRemoteTracksOnlyClosesExactMissingPublication(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	tenantID := reconciliationTestID(t, "11111111-1111-4111-8111-111111111111")
	episodeID := reconciliationTestID(t, "22222222-2222-4222-8222-222222222222")
	participantID := reconciliationTestID(t, "33333333-3333-4333-8333-333333333333")
	repository := &reconciliationRepositoryStub{}
	service := newService(repository, func() time.Time { return now })
	_, err := service.RecordPublishedTracks(context.Background(), RecordInput{
		TenantID: tenantID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: 1, ConnectionID: "publisher-connection",
		Tracks: []PublishedTrack{
			{Source: "camera", MID: "camera-mid", TrackName: "camera-track"},
			{Source: "microphone", MID: "microphone-mid", TrackName: "microphone-track"},
		},
	})
	if err != nil {
		t.Fatalf("publish tracks: %v", err)
	}
	camera := RemoteTrackIdentity{ConnectionID: "publisher-connection", TrackName: "camera-track"}
	microphone := RemoteTrackIdentity{ConnectionID: "publisher-connection", TrackName: "microphone-track"}
	input := RemoteTrackObservationInput{
		TenantID: tenantID, EpisodeID: episodeID,
		Requested: []RemoteTrackIdentity{camera, microphone}, Missing: []RemoteTrackIdentity{camera},
	}
	for _, advance := range []time.Duration{0, 4 * time.Second, 4 * time.Second, 8 * time.Second} {
		now = now.Add(advance)
		if err := service.ObserveRemoteTracks(context.Background(), input); err != nil {
			t.Fatalf("observe camera absence: %v", err)
		}
	}

	assertPublicationEnabled(t, repository.appended.Publications, participantID, "camera", false)
	assertPublicationEnabled(t, repository.appended.Publications, participantID, "microphone", true)
}

func TestObserveRemoteTracksDoesNotCloseReplacementPublication(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	repository := &reconciliationRepositoryStub{}
	service := newService(repository, func() time.Time { return now })
	tenantID, episodeID, participantID, oldIdentity := publishRemoteObservationFixture(t, service, repository)
	oldMissing := RemoteTrackObservationInput{TenantID: tenantID, EpisodeID: episodeID, Requested: []RemoteTrackIdentity{oldIdentity}, Missing: []RemoteTrackIdentity{oldIdentity}}
	if err := service.ObserveRemoteTracks(context.Background(), oldMissing); err != nil {
		t.Fatalf("observe old absence: %v", err)
	}
	now = now.Add(4 * time.Second)
	if err := service.ObserveRemoteTracks(context.Background(), oldMissing); err != nil {
		t.Fatalf("observe old absence again: %v", err)
	}
	_, err := service.RecordPublishedTracks(context.Background(), RecordInput{
		TenantID: tenantID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: 2, ConnectionID: "replacement-connection",
		Tracks: []PublishedTrack{{Source: "camera", MID: "replacement-mid", TrackName: "replacement-track"}},
	})
	if err != nil {
		t.Fatalf("publish replacement: %v", err)
	}
	now = now.Add(20 * time.Second)
	if err := service.ObserveRemoteTracks(context.Background(), oldMissing); err != nil {
		t.Fatalf("observe stale identity after replacement: %v", err)
	}

	assertPublicationEnabled(t, repository.appended.Publications, participantID, "camera", true)
	if len(repository.appendedInputs) != 2 {
		t.Fatalf("append count = %d, want original and replacement publications only", len(repository.appendedInputs))
	}
}

type reconciliationRepositoryStub struct {
	observations   []provideroperations.Observation
	appended       provideroperations.ObservationInput
	appendedInputs []provideroperations.ObservationInput
}

func (r *reconciliationRepositoryStub) AppendObservation(_ context.Context, input provideroperations.ObservationInput) (provideroperations.Observation, error) {
	r.appended = input
	r.appendedInputs = append(r.appendedInputs, input)
	observation := provideroperations.Observation{TenantID: input.TenantID, EpisodeID: input.EpisodeID, Incarnation: input.Incarnation, Sequence: input.Sequence, Publications: input.Publications}
	r.observations = append(r.observations, observation)
	return observation, nil
}

func (r *reconciliationRepositoryStub) ListObservations(_ context.Context, _, _ utilities.ID, _ *provideroperations.Cursor, _ int) (provideroperations.ObservationPage, error) {
	return provideroperations.ObservationPage{Observations: r.observations}, nil
}

func publishRemoteObservationFixture(t *testing.T, service Service, repository *reconciliationRepositoryStub) (tenantID, episodeID, participantID utilities.ID, identity RemoteTrackIdentity) {
	t.Helper()
	tenantID = reconciliationTestID(t, "11111111-1111-4111-8111-111111111111")
	episodeID = reconciliationTestID(t, "22222222-2222-4222-8222-222222222222")
	participantID = reconciliationTestID(t, "33333333-3333-4333-8333-333333333333")
	_, err := service.RecordPublishedTracks(context.Background(), RecordInput{
		TenantID: tenantID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: 1, ConnectionID: "publisher-connection",
		Tracks: []PublishedTrack{{Source: "camera", MID: "camera-mid", TrackName: "camera-track"}},
	})
	if err != nil {
		t.Fatalf("publish track: %v", err)
	}
	return tenantID, episodeID, participantID, RemoteTrackIdentity{ConnectionID: "publisher-connection", TrackName: "camera-track"}
}

func reconciliationTestID(t *testing.T, raw string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(raw)
	if err != nil {
		t.Fatalf("parse id: %v", err)
	}
	return id
}

func assertPublicationEnabled(t *testing.T, publications []provideroperations.Publication, participantID utilities.ID, source string, enabled bool) {
	t.Helper()
	for _, publication := range publications {
		if publication.ParticipantID == participantID && publication.Source == source {
			if publication.Enabled != enabled {
				t.Fatalf("publication %s enabled = %t, want %t", source, publication.Enabled, enabled)
			}
			return
		}
	}
	t.Fatalf("publication %s missing from %#v", source, publications)
}
