package mediapublications

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// stuckFor is a failure age past the grace and the 2 s claim dedupe window.
const stuckFor = publicationActiveTrackGrace + 500*time.Millisecond

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

func TestPublicationLivenessEvidenceClearsWhenPublicationCloses(t *testing.T) {
	t.Run("failure confirmation", func(t *testing.T) {
		now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
		repository := &reconciliationRepositoryStub{}
		service := newService(repository, func() time.Time { return now })
		tenantID, episodeID, _, identity := publishRemoteObservationFixture(t, service, repository)
		listenerID := reconciliationTestID(t, "44444444-4444-4444-8444-444444444444")

		if err := service.ObserveRemoteTracks(context.Background(), RemoteTrackObservationInput{
			TenantID: tenantID, EpisodeID: episodeID, ListenerParticipantID: listenerID,
			ListenerConnectionID: livenessListenerConnectionID(listenerID),
			Requested:            []RemoteTrackIdentity{identity},
		}); err != nil {
			t.Fatalf("record successful pull: %v", err)
		}
		confirmActiveTrackFailure(t, service, tenantID, episodeID, listenerID, identity)
		now = now.Add(publicationActiveTrackGrace)
		result := confirmActiveTrackFailure(t, service, tenantID, episodeID, listenerID, identity)
		if result.Closed != 1 {
			t.Fatalf("repeat failure result=%+v, want publication closed", result)
		}
		assertLivenessEvidenceEmpty(t, service)
	})

	t.Run("remote track reconciliation", func(t *testing.T) {
		now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
		repository := &reconciliationRepositoryStub{}
		service := newService(repository, func() time.Time { return now })
		tenantID, episodeID, _, identity := publishRemoteObservationFixture(t, service, repository)
		listenerID := reconciliationTestID(t, "44444444-4444-4444-8444-444444444444")
		latest, err := service.latest(context.Background(), tenantID, episodeID)
		if err != nil {
			t.Fatalf("read publication: %v", err)
		}
		candidates := remotePublicationCandidates(tenantID, episodeID, latest)
		if len(candidates) != 1 {
			t.Fatalf("publication candidates=%d, want 1", len(candidates))
		}
		candidate := candidates[0]
		service.liveness.recordServed(servedKey{
			tenantID: tenantID.String(), episodeID: episodeID.String(), identity: candidate.identity,
		}, listenerID, livenessListenerConnectionID(listenerID))
		service.liveness.recordFailure(servedKey{
			tenantID: tenantID.String(), episodeID: episodeID.String(), identity: candidate.identity,
		}, listenerID, livenessListenerConnectionID(listenerID))

		input := RemoteTrackObservationInput{
			TenantID: tenantID, EpisodeID: episodeID, ListenerParticipantID: listenerID,
			ListenerConnectionID: livenessListenerConnectionID(listenerID),
			Requested:            []RemoteTrackIdentity{identity}, Missing: []RemoteTrackIdentity{identity},
		}
		for _, advance := range []time.Duration{0, 8 * time.Second, 7 * time.Second} {
			now = now.Add(advance)
			if err := service.ObserveRemoteTracks(context.Background(), input); err != nil {
				t.Fatalf("observe missing track: %v", err)
			}
		}
		assertLivenessEvidenceEmpty(t, service)
	})
}

func TestPublicationLivenessEvidenceMapsAreBounded(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	checks := newPublicationLivenessChecks(func() time.Time { return now })
	identity := RemoteTrackIdentity{ConnectionID: "connection-0", TrackName: "track"}
	key := servedKey{tenantID: "tenant", episodeID: "episode", identity: identity}
	for index := 1; index <= 65; index++ {
		listenerID := reconciliationTestID(t, fmt.Sprintf("00000000-0000-4000-8000-%012x", index))
		checks.recordServed(key, listenerID, fmt.Sprintf("listener-%d", index))
		now = now.Add(time.Nanosecond)
	}
	if got := len(checks.evidence[key]); got != 64 {
		t.Fatalf("listeners for one key=%d, want 64", got)
	}
	for index := 0; index <= publicationLivenessEvidenceMaxKeys; index++ {
		identity := RemoteTrackIdentity{ConnectionID: fmt.Sprintf("connection-%d", index), TrackName: "track"}
		listenerID := reconciliationTestID(t, "44444444-4444-4444-8444-444444444444")
		checks.recordServed(servedKey{tenantID: "tenant", episodeID: "episode", identity: identity}, listenerID, "listener")
	}
	if len(checks.evidence) > publicationLivenessEvidenceMaxKeys {
		t.Fatalf("liveness evidence keys=%d, want at most %d", len(checks.evidence), publicationLivenessEvidenceMaxKeys)
	}
}

func confirmActiveTrackFailure(t *testing.T, service Service, tenantID, episodeID, listenerID utilities.ID, identity RemoteTrackIdentity) RemoteTrackFailureResult {
	t.Helper()
	if repository, ok := service.repository.(*reconciliationRepositoryStub); ok {
		ensureLivenessListenerPresence(repository)
	}
	result, err := service.ConfirmRemoteTrackFailures(context.Background(), RemoteTrackFailureInput{
		TenantID: tenantID, EpisodeID: episodeID, ListenerParticipantID: listenerID,
		ListenerConnectionID: livenessListenerConnectionID(listenerID),
		Failed:               []RemoteTrackIdentity{identity},
	}, func(context.Context, string) (PublisherSession, error) {
		return PublisherSession{Found: true, Tracks: []PublisherTrack{{MID: "camera-mid", TrackName: "camera-track", Active: true}}}, nil
	})
	if err != nil {
		t.Fatalf("confirm listener failure: %v", err)
	}
	return result
}

func assertLivenessEvidenceEmpty(t *testing.T, service Service) {
	t.Helper()
	service.liveness.mu.Lock()
	defer service.liveness.mu.Unlock()
	if len(service.liveness.evidence) != 0 {
		t.Fatalf("liveness evidence keys=%d, want empty", len(service.liveness.evidence))
	}
}
