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
	repository := &repositoryStub{}
	service := newService(repository, func() time.Time { return now })
	tenantID, episodeID, participantID, identity := publishRemoteObservationFixture(t, service, repository)
	input := RemoteTrackObservationInput{TenantID: tenantID, EpisodeID: episodeID, Requested: []RemoteTrackIdentity{identity}, Missing: []RemoteTrackIdentity{identity}}

	if err := service.ObserveRemoteTracks(context.Background(), input); err != nil {
		t.Fatalf("observe first absence: %v", err)
	}
	now = now.Add(4 * time.Second)
	if err := service.ObserveRemoteTracks(context.Background(), input); err != nil {
		t.Fatalf("observe second absence: %v", err)
	}
	if len(repository.appendedInputs) != 1 {
		t.Fatalf("append count before grace = %d, want publication only", len(repository.appendedInputs))
	}
	now = now.Add(4 * time.Second)
	if err := service.ObserveRemoteTracks(context.Background(), input); err != nil {
		t.Fatalf("observe third absence within grace: %v", err)
	}
	if len(repository.appendedInputs) != 1 {
		t.Fatalf("append count through 8 seconds = %d, want publication only", len(repository.appendedInputs))
	}
	now = now.Add(4 * time.Second)
	if err := service.ObserveRemoteTracks(context.Background(), input); err != nil {
		t.Fatalf("observe fourth absence within grace: %v", err)
	}
	if len(repository.appendedInputs) != 1 {
		t.Fatalf("append count through 12 seconds = %d, want publication only", len(repository.appendedInputs))
	}
	now = now.Add(4 * time.Second)
	if err := service.ObserveRemoteTracks(context.Background(), input); err != nil {
		t.Fatalf("observe confirmed absence after grace: %v", err)
	}

	assertPublicationEnabled(t, repository.appended.Publications, participantID, "camera", false)
}

func TestObserveRemoteTracksCountsParallelMissesAsOneEvidenceWave(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	repository := &repositoryStub{}
	service := newService(repository, func() time.Time { return now })
	tenantID, episodeID, participantID, identity := publishRemoteObservationFixture(t, service, repository)
	input := RemoteTrackObservationInput{TenantID: tenantID, EpisodeID: episodeID, Requested: []RemoteTrackIdentity{identity}, Missing: []RemoteTrackIdentity{identity}}

	for index := 0; index < 4; index++ {
		if err := service.ObserveRemoteTracks(context.Background(), input); err != nil {
			t.Fatalf("observe parallel absence %d: %v", index+1, err)
		}
	}
	now = now.Add(4 * time.Second)
	if err := service.ObserveRemoteTracks(context.Background(), input); err != nil {
		t.Fatalf("observe second evidence wave: %v", err)
	}
	if len(repository.appendedInputs) != 1 {
		t.Fatalf("append count after two evidence waves = %d, want publication only", len(repository.appendedInputs))
	}
	now = now.Add(4 * time.Second)
	if err := service.ObserveRemoteTracks(context.Background(), input); err != nil {
		t.Fatalf("observe third evidence wave: %v", err)
	}
	now = now.Add(8 * time.Second)
	if err := service.ObserveRemoteTracks(context.Background(), input); err != nil {
		t.Fatalf("observe confirmed absence after grace: %v", err)
	}

	assertPublicationEnabled(t, repository.appended.Publications, participantID, "camera", false)
}

func TestObserveRemoteTracksSuccessResetsAbsenceEvidence(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	repository := &repositoryStub{}
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
	tenantID := testID(t, "11111111-1111-4111-8111-111111111111")
	episodeID := testID(t, "22222222-2222-4222-8222-222222222222")
	participantID := testID(t, "33333333-3333-4333-8333-333333333333")
	repository := &repositoryStub{}
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
	for index := 0; index < remoteTrackAbsenceMinimumObservations; index++ {
		if err := service.ObserveRemoteTracks(context.Background(), input); err != nil {
			t.Fatalf("observe camera absence %d: %v", index+1, err)
		}
		now = now.Add(4 * time.Second)
	}
	now = now.Add(4 * time.Second)
	if err := service.ObserveRemoteTracks(context.Background(), input); err != nil {
		t.Fatalf("observe camera absence after grace: %v", err)
	}

	assertPublicationEnabled(t, repository.appended.Publications, participantID, "camera", false)
	assertPublicationEnabled(t, repository.appended.Publications, participantID, "microphone", true)
}

func TestObserveRemoteTracksDoesNotCloseReplacementPublication(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	repository := &repositoryStub{}
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
	now = now.Add(4 * time.Second)
	if err := service.ObserveRemoteTracks(context.Background(), oldMissing); err != nil {
		t.Fatalf("observe stale identity after replacement: %v", err)
	}

	assertPublicationEnabled(t, repository.appended.Publications, participantID, "camera", true)
	if len(repository.appendedInputs) != 2 {
		t.Fatalf("append count = %d, want original and replacement publications only", len(repository.appendedInputs))
	}
}

func publishRemoteObservationFixture(t *testing.T, service Service, repository *repositoryStub) (tenantID, episodeID, participantID utilities.ID, identity RemoteTrackIdentity) {
	t.Helper()
	tenantID = testID(t, "11111111-1111-4111-8111-111111111111")
	episodeID = testID(t, "22222222-2222-4222-8222-222222222222")
	participantID = testID(t, "33333333-3333-4333-8333-333333333333")
	_, err := service.RecordPublishedTracks(context.Background(), RecordInput{
		TenantID: tenantID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: 1, ConnectionID: "publisher-connection",
		Tracks: []PublishedTrack{{Source: "camera", MID: "camera-mid", TrackName: "camera-track"}},
	})
	if err != nil {
		t.Fatalf("publish track: %v", err)
	}
	if len(repository.appended.Publications) != 1 {
		t.Fatalf("published snapshot = %#v", repository.appended.Publications)
	}
	return tenantID, episodeID, participantID, RemoteTrackIdentity{ConnectionID: "publisher-connection", TrackName: "camera-track"}
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
