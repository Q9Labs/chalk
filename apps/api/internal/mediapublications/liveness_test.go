package mediapublications

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestConfirmRemoteTrackFailuresClosesOnlyGoneOrInactiveTracks(t *testing.T) {
	for _, test := range []struct {
		name    string
		session PublisherSession
		inspect error
		closed  int
		present int
		failed  int
	}{
		{name: "missing track", session: PublisherSession{Found: true}, closed: 1},
		{name: "inactive track", session: PublisherSession{Found: true, Tracks: []PublisherTrack{{MID: "camera-mid", TrackName: "camera-track"}}}, closed: 1},
		{name: "session not found", session: PublisherSession{Found: false}, closed: 1},
		{name: "present active", session: PublisherSession{Found: true, Tracks: []PublisherTrack{{MID: "camera-mid", TrackName: "camera-track", Active: true}}}, present: 1},
		{name: "inspection error", inspect: errors.New("inspection failed"), failed: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			repository := &reconciliationRepositoryStub{}
			service := newService(repository, time.Now)
			tenantID, episodeID, participantID, identity := publishRemoteObservationFixture(t, service, repository)
			calls := 0
			result, err := service.ConfirmRemoteTrackFailures(context.Background(), RemoteTrackFailureInput{
				TenantID: tenantID, EpisodeID: episodeID, Failed: []RemoteTrackIdentity{identity},
			}, func(context.Context, string) (PublisherSession, error) {
				calls++
				return test.session, test.inspect
			})
			if err != nil {
				t.Fatalf("confirm failures: %v", err)
			}
			if calls != 1 || result.Checked != 1 || result.Closed != test.closed || result.Present != test.present || result.Failed != test.failed {
				t.Fatalf("calls=%d result=%+v", calls, result)
			}
			assertPublicationEnabled(t, repository.appended.Publications, participantID, "camera", test.closed == 0)
			if len(repository.appendedInputs) != 1+test.closed {
				t.Fatalf("observation append count=%d, want %d", len(repository.appendedInputs), 1+test.closed)
			}
		})
	}
}

func TestConfirmRemoteTrackFailuresDeduplicatesAndExpiresClaims(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	repository := &reconciliationRepositoryStub{}
	service := newService(repository, func() time.Time { return now })
	tenantID, episodeID, _, identity := publishRemoteObservationFixture(t, service, repository)
	calls := 0
	reader := func(context.Context, string) (PublisherSession, error) {
		calls++
		return PublisherSession{Found: true, Tracks: []PublisherTrack{{MID: "camera-mid", TrackName: "camera-track", Active: true}}}, nil
	}
	input := RemoteTrackFailureInput{TenantID: tenantID, EpisodeID: episodeID, Failed: []RemoteTrackIdentity{identity}}
	deduped := 0
	for range 5 {
		result, err := service.ConfirmRemoteTrackFailures(context.Background(), input, reader)
		if err != nil {
			t.Fatalf("confirm listener failure: %v", err)
		}
		deduped += result.Deduped
	}
	if calls != 1 || deduped != 4 {
		t.Fatalf("reader calls=%d deduped=%d, want 1 and 4", calls, deduped)
	}
	now = now.Add(publicationLivenessDedupeWindow)
	if _, err := service.ConfirmRemoteTrackFailures(context.Background(), input, reader); err != nil {
		t.Fatalf("confirm after dedupe window: %v", err)
	}
	if calls != 2 {
		t.Fatalf("reader calls after dedupe expiry=%d, want 2", calls)
	}
}

// Cloudflare can list a pushed track as active while every listener pull of it fails
// with "track not found on remote peer" for tens of seconds. The publisher is
// connected and sending, so only a new publication gets listeners audio again.
func TestConfirmRemoteTrackFailuresWithdrawsActiveTrackListenersStillFail(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	repository := &reconciliationRepositoryStub{}
	service := newService(repository, func() time.Time { return now })
	tenantID, episodeID, participantID, identity := publishRemoteObservationFixture(t, service, repository)
	reader := func(context.Context, string) (PublisherSession, error) {
		return PublisherSession{Found: true, Tracks: []PublisherTrack{{MID: "camera-mid", TrackName: "camera-track", Active: true}}}, nil
	}
	input := RemoteTrackFailureInput{TenantID: tenantID, EpisodeID: episodeID, Failed: []RemoteTrackIdentity{identity}}

	first, err := service.ConfirmRemoteTrackFailures(context.Background(), input, reader)
	if err != nil || first.Present != 1 || first.Closed != 0 {
		t.Fatalf("first confirmation result=%+v err=%v, want the track kept while it may still be starting", first, err)
	}
	assertPublicationEnabled(t, repository.appended.Publications, participantID, "camera", true)

	now = now.Add(publicationLivenessDedupeWindow)
	second, err := service.ConfirmRemoteTrackFailures(context.Background(), input, reader)
	if err != nil || second.Closed != 1 || second.Present != 0 {
		t.Fatalf("second confirmation result=%+v err=%v, want the track still failing for listeners withdrawn", second, err)
	}
	assertPublicationEnabled(t, repository.appended.Publications, participantID, "camera", false)
}

func TestConfirmRemoteTrackFailuresInspectsPublisherOnceForMultipleTracks(t *testing.T) {
	repository := &reconciliationRepositoryStub{}
	service := newService(repository, time.Now)
	tenantID := reconciliationTestID(t, "11111111-1111-4111-8111-111111111111")
	episodeID := reconciliationTestID(t, "22222222-2222-4222-8222-222222222222")
	participantID := reconciliationTestID(t, "33333333-3333-4333-8333-333333333333")
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
	calls := 0
	result, err := service.ConfirmRemoteTrackFailures(context.Background(), RemoteTrackFailureInput{
		TenantID: tenantID, EpisodeID: episodeID,
		Failed: []RemoteTrackIdentity{
			{ConnectionID: "publisher-connection", TrackName: "camera-track"},
			{ConnectionID: "publisher-connection", TrackName: "microphone-track"},
		},
	}, func(context.Context, string) (PublisherSession, error) {
		calls++
		return PublisherSession{Found: true, Tracks: []PublisherTrack{
			{MID: "camera-mid", TrackName: "camera-track", Active: true},
			{MID: "microphone-mid", TrackName: "microphone-track", Active: true},
		}}, nil
	})
	if err != nil || calls != 1 || result.Checked != 2 || result.Present != 2 {
		t.Fatalf("calls=%d result=%+v err=%v", calls, result, err)
	}
}
