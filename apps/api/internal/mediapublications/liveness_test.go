package mediapublications

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
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
	listenerID := reconciliationTestID(t, "44444444-4444-4444-8444-444444444444")
	ensureLivenessListenerPresence(repository)
	reader := func(context.Context, string) (PublisherSession, error) {
		return PublisherSession{Found: true, Tracks: []PublisherTrack{{MID: "camera-mid", TrackName: "camera-track", Active: true}}}, nil
	}
	input := RemoteTrackFailureInput{
		TenantID: tenantID, EpisodeID: episodeID, ListenerParticipantID: listenerID,
		ListenerConnectionID: livenessListenerConnectionID(listenerID),
		Failed:               []RemoteTrackIdentity{identity},
	}

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

func TestConfirmRemoteTrackFailuresRequiresAnotherListenerWhenOthersWereServed(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	repository := &reconciliationRepositoryStub{}
	service := newService(repository, func() time.Time { return now })
	tenantID, episodeID, publisherID, identity := publishRemoteObservationFixture(t, service, repository)
	listenerA := reconciliationTestID(t, "44444444-4444-4444-8444-444444444444")
	listenerB := reconciliationTestID(t, "55555555-5555-4555-8555-555555555555")
	listenerC := reconciliationTestID(t, "66666666-6666-4666-8666-666666666666")

	if err := service.ObserveRemoteTracks(context.Background(), RemoteTrackObservationInput{
		TenantID: tenantID, EpisodeID: episodeID, ListenerParticipantID: listenerB,
		ListenerConnectionID: livenessListenerConnectionID(listenerB),
		Requested:            []RemoteTrackIdentity{identity},
	}); err != nil {
		t.Fatalf("record listener B's successful pull: %v", err)
	}
	first := confirmActiveTrackFailure(t, service, tenantID, episodeID, listenerA, identity)
	if first.Present != 1 || first.Closed != 0 {
		t.Fatalf("first listener A failure result=%+v, want Present", first)
	}
	now = now.Add(publicationLivenessDedupeWindow)
	second := confirmActiveTrackFailure(t, service, tenantID, episodeID, listenerA, identity)
	if second.Present != 1 || second.Closed != 0 {
		t.Fatalf("repeat listener A failure result=%+v, want Present while listener B has succeeded", second)
	}
	assertPublicationEnabled(t, repository.appended.Publications, publisherID, "camera", true)

	now = now.Add(publicationLivenessDedupeWindow)
	third := confirmActiveTrackFailure(t, service, tenantID, episodeID, listenerC, identity)
	if third.Closed != 1 || third.Present != 0 {
		t.Fatalf("listener C failure result=%+v, want withdrawal after a second listener reports failure", third)
	}
	assertPublicationEnabled(t, repository.appended.Publications, publisherID, "camera", false)
}

func TestConfirmRemoteTrackFailuresIgnoresReporterOwnSuccessfulPull(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	repository := &reconciliationRepositoryStub{}
	service := newService(repository, func() time.Time { return now })
	tenantID, episodeID, publisherID, identity := publishRemoteObservationFixture(t, service, repository)
	listenerA := reconciliationTestID(t, "44444444-4444-4444-8444-444444444444")

	if err := service.ObserveRemoteTracks(context.Background(), RemoteTrackObservationInput{
		TenantID: tenantID, EpisodeID: episodeID, ListenerParticipantID: listenerA,
		ListenerConnectionID: livenessListenerConnectionID(listenerA),
		Requested:            []RemoteTrackIdentity{identity},
	}); err != nil {
		t.Fatalf("record listener A's successful pull: %v", err)
	}
	first := confirmActiveTrackFailure(t, service, tenantID, episodeID, listenerA, identity)
	if first.Present != 1 || first.Closed != 0 {
		t.Fatalf("first listener A failure result=%+v, want Present", first)
	}
	now = now.Add(publicationLivenessDedupeWindow)
	second := confirmActiveTrackFailure(t, service, tenantID, episodeID, listenerA, identity)
	if second.Closed != 1 || second.Present != 0 {
		t.Fatalf("repeat listener A failure result=%+v, want withdrawal in the 1:1 case", second)
	}
	assertPublicationEnabled(t, repository.appended.Publications, publisherID, "camera", false)
}

func TestConfirmRemoteTrackFailuresDoesNotCountUnknownListener(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	repository := &reconciliationRepositoryStub{}
	service := newService(repository, func() time.Time { return now })
	tenantID, episodeID, publisherID, identity := publishRemoteObservationFixture(t, service, repository)
	listenerA := reconciliationTestID(t, "44444444-4444-4444-8444-444444444444")
	listenerB := reconciliationTestID(t, "55555555-5555-4555-8555-555555555555")
	listenerC := reconciliationTestID(t, "66666666-6666-4666-8666-666666666666")

	if err := service.ObserveRemoteTracks(context.Background(), RemoteTrackObservationInput{
		TenantID: tenantID, EpisodeID: episodeID, ListenerParticipantID: listenerB,
		ListenerConnectionID: livenessListenerConnectionID(listenerB),
		Requested:            []RemoteTrackIdentity{identity},
	}); err != nil {
		t.Fatalf("record listener B's successful pull: %v", err)
	}
	first := confirmActiveTrackFailure(t, service, tenantID, episodeID, listenerA, identity)
	if first.Present != 1 || first.Closed != 0 {
		t.Fatalf("first listener A failure result=%+v, want Present", first)
	}
	now = now.Add(publicationLivenessDedupeWindow)
	unknown := confirmActiveTrackFailure(t, service, tenantID, episodeID, utilities.ID{}, identity)
	if unknown.Present != 1 || unknown.Closed != 0 {
		t.Fatalf("unknown listener failure result=%+v, want Present", unknown)
	}
	assertPublicationEnabled(t, repository.appended.Publications, publisherID, "camera", true)

	now = now.Add(publicationLivenessDedupeWindow)
	third := confirmActiveTrackFailure(t, service, tenantID, episodeID, listenerC, identity)
	if third.Closed != 1 || third.Present != 0 {
		t.Fatalf("listener C failure result=%+v, want withdrawal after two known listeners report failure", third)
	}
	assertPublicationEnabled(t, repository.appended.Publications, publisherID, "camera", false)
}

func TestConfirmRemoteTrackFailuresExpiresSightingWindow(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	repository := &reconciliationRepositoryStub{}
	service := newService(repository, func() time.Time { return now })
	tenantID, episodeID, publisherID, identity := publishRemoteObservationFixture(t, service, repository)
	listenerID := reconciliationTestID(t, "44444444-4444-4444-8444-444444444444")

	first := confirmActiveTrackFailure(t, service, tenantID, episodeID, listenerID, identity)
	if first.Present != 1 || first.Closed != 0 {
		t.Fatalf("first failure result=%+v, want Present", first)
	}
	now = now.Add(publicationStillFailingWindow)
	second := confirmActiveTrackFailure(t, service, tenantID, episodeID, listenerID, identity)
	if second.Present != 1 || second.Closed != 0 {
		t.Fatalf("failure after the sighting window result=%+v, want a fresh Present sighting", second)
	}
	assertPublicationEnabled(t, repository.appended.Publications, publisherID, "camera", true)
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
		now = now.Add(publicationLivenessDedupeWindow)
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

func livenessListenerConnectionID(listenerID utilities.ID) string {
	return "listener-" + listenerID.String()
}

func ensureLivenessListenerPresence(repository *reconciliationRepositoryStub) {
	if repository.participants != nil {
		return
	}
	publisherID, _ := utilities.ParseID("33333333-3333-4333-8333-333333333333")
	participants := []PublicationParticipant{{ID: publisherID, Generation: 1, ConnectionID: "publisher-connection"}}
	for _, rawID := range []string{
		"44444444-4444-4444-8444-444444444444",
		"55555555-5555-4555-8555-555555555555",
		"66666666-6666-4666-8666-666666666666",
	} {
		listenerID, _ := utilities.ParseID(rawID)
		participants = append(participants, PublicationParticipant{ID: listenerID, Generation: 1, ConnectionID: livenessListenerConnectionID(listenerID)})
	}
	repository.participants = participants
}

func TestPublicationWithdrawalFollowsPresentListeners(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	publisherID := reconciliationTestID(t, "33333333-3333-4333-8333-333333333333")
	listenerA := reconciliationTestID(t, "44444444-4444-4444-8444-444444444444")
	listenerB := reconciliationTestID(t, "55555555-5555-4555-8555-555555555555")

	type step struct {
		name            string
		advance         time.Duration
		listenerID      utilities.ID
		connectionID    string
		kind            string
		presence        []PublicationParticipant
		wantWithdrawn   bool
		wantReaderCalls int
		wantDeduped     int
	}
	presence := func(listeners ...PublicationParticipant) []PublicationParticipant {
		participants := []PublicationParticipant{{ID: publisherID, Generation: 1, ConnectionID: "publisher-connection"}}
		return append(participants, listeners...)
	}
	listener := func(id utilities.ID, connectionID string) PublicationParticipant {
		return PublicationParticipant{ID: id, Generation: 1, ConnectionID: connectionID}
	}
	tests := []struct {
		name  string
		steps []step
	}{
		{
			name: "one to one",
			steps: []step{
				{name: "first failure", listenerID: listenerA, connectionID: "a", kind: "fail", presence: presence(listener(listenerA, "a")), wantReaderCalls: 1},
				{name: "repeat failure", advance: 2500 * time.Millisecond, listenerID: listenerA, connectionID: "a", kind: "fail", presence: presence(listener(listenerA, "a")), wantWithdrawn: true, wantReaderCalls: 2},
			},
		},
		{
			name: "not_found_track_error for a single present listener",
			steps: []step{
				{name: "first missing-publication report", listenerID: listenerA, connectionID: "a", kind: "fail", presence: presence(listener(listenerA, "a")), wantReaderCalls: 1},
				{name: "repeated missing-publication report", advance: 2500 * time.Millisecond, listenerID: listenerA, connectionID: "a", kind: "fail", presence: presence(listener(listenerA, "a")), wantWithdrawn: true, wantReaderCalls: 2},
			},
		},
		{
			name: "failing listener left before the threshold",
			steps: []step{
				{name: "A fails on a1", listenerID: listenerA, connectionID: "a1", kind: "fail", presence: presence(listener(listenerA, "a1")), wantReaderCalls: 1},
				{name: "B fails for the first time after A leaves", advance: 2500 * time.Millisecond, listenerID: listenerB, connectionID: "b1", kind: "fail", presence: presence(listener(listenerB, "b1")), wantReaderCalls: 2},
			},
		},
		{
			name: "failing listener reconnected before the threshold",
			steps: []step{
				{name: "A fails on a1", listenerID: listenerA, connectionID: "a1", kind: "fail", presence: presence(listener(listenerA, "a1")), wantReaderCalls: 1},
				{name: "B fails while A is present on a2", advance: 2500 * time.Millisecond, listenerID: listenerB, connectionID: "b1", kind: "fail", presence: presence(listener(listenerA, "a2"), listener(listenerB, "b1")), wantReaderCalls: 2},
			},
		},
		{
			name: "reconnected listener's new failure restarts its window",
			steps: []step{
				{name: "A fails on a1", listenerID: listenerA, connectionID: "a1", kind: "fail", presence: presence(listener(listenerA, "a1")), wantReaderCalls: 1},
				{name: "A fails on a2 after reconnecting", advance: 2500 * time.Millisecond, listenerID: listenerA, connectionID: "a2", kind: "fail", presence: presence(listener(listenerA, "a2")), wantReaderCalls: 2},
			},
		},
		{
			name: "listener who left",
			steps: []step{
				{name: "listener B served", listenerID: listenerB, connectionID: "b", kind: "served", presence: presence(listener(listenerB, "b"))},
				{name: "A first failure", advance: time.Second, listenerID: listenerA, connectionID: "a", kind: "fail", presence: presence(listener(listenerA, "a")), wantReaderCalls: 1},
				{name: "A repeat failure", advance: 2500 * time.Millisecond, listenerID: listenerA, connectionID: "a", kind: "fail", presence: presence(listener(listenerA, "a")), wantWithdrawn: true, wantReaderCalls: 2},
			},
		},
		{
			name: "listener whose media connection changed",
			steps: []step{
				{name: "B served on b1", listenerID: listenerB, connectionID: "b1", kind: "served", presence: presence(listener(listenerB, "b1"))},
				{name: "A first failure", advance: time.Second, listenerID: listenerA, connectionID: "a", kind: "fail", presence: presence(listener(listenerA, "a"), listener(listenerB, "b2")), wantReaderCalls: 1},
				{name: "A repeat failure", advance: 2500 * time.Millisecond, listenerID: listenerA, connectionID: "a", kind: "fail", presence: presence(listener(listenerA, "a"), listener(listenerB, "b2")), wantWithdrawn: true, wantReaderCalls: 2},
			},
		},
		{
			name: "two listeners failing within 2 s",
			steps: []step{
				{name: "B served", listenerID: listenerB, connectionID: "b", kind: "served", presence: presence(listener(listenerA, "a"), listener(listenerB, "b"))},
				{name: "A fails", advance: time.Second, listenerID: listenerA, connectionID: "a", kind: "fail", wantReaderCalls: 1},
				{name: "B fails while the reader is deduped", advance: 500 * time.Millisecond, listenerID: listenerB, connectionID: "b", kind: "fail", wantReaderCalls: 1, wantDeduped: 1},
				{name: "A repeats after 2.5 s", advance: 2 * time.Second, listenerID: listenerA, connectionID: "a", kind: "fail", wantWithdrawn: true, wantReaderCalls: 2},
			},
		},
		{
			name: "fail then succeed then fail",
			steps: []step{
				{name: "first failure", listenerID: listenerA, connectionID: "a", kind: "fail", presence: presence(listener(listenerA, "a")), wantReaderCalls: 1},
				{name: "successful pull", advance: time.Second, listenerID: listenerA, connectionID: "a", kind: "served", wantReaderCalls: 1},
				{name: "failure after success", advance: 1500 * time.Millisecond, listenerID: listenerA, connectionID: "a", kind: "fail", wantReaderCalls: 2},
				{name: "repeat after the new failure", advance: 2500 * time.Millisecond, listenerID: listenerA, connectionID: "a", kind: "fail", wantWithdrawn: true, wantReaderCalls: 3},
			},
		},
		{
			name: "one broken listener while others are served",
			steps: []step{
				{name: "B served", listenerID: listenerB, connectionID: "b", kind: "served", presence: presence(listener(listenerA, "a"), listener(listenerB, "b"))},
				{name: "A first failure", advance: time.Second, listenerID: listenerA, connectionID: "a", kind: "fail", wantReaderCalls: 1},
				{name: "A repeat failure", advance: 2500 * time.Millisecond, listenerID: listenerA, connectionID: "a", kind: "fail", wantReaderCalls: 2},
				{name: "A keeps failing", advance: 2500 * time.Millisecond, listenerID: listenerA, connectionID: "a", kind: "fail", wantReaderCalls: 3},
			},
		},
		{
			name: "served evidence expires",
			steps: []step{
				{name: "B served", listenerID: listenerB, connectionID: "b", kind: "served", presence: presence(listener(listenerA, "a"), listener(listenerB, "b"))},
				{name: "A first failure after expiry", advance: 31 * time.Second, listenerID: listenerA, connectionID: "a", kind: "fail", wantReaderCalls: 1},
				{name: "A repeat failure", advance: 2500 * time.Millisecond, listenerID: listenerA, connectionID: "a", kind: "fail", wantWithdrawn: true, wantReaderCalls: 2},
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			now = time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
			repository := &reconciliationRepositoryStub{
				participants: presence(),
			}
			service := newService(repository, func() time.Time { return now })
			tenantID, episodeID, publisherID, identity := publishRemoteObservationFixture(t, service, repository)
			if publisherID != reconciliationTestID(t, "33333333-3333-4333-8333-333333333333") {
				t.Fatal("fixture publisher ID changed")
			}
			readerCalls := 0
			reader := func(context.Context, string) (PublisherSession, error) {
				readerCalls++
				return PublisherSession{Found: true, Tracks: []PublisherTrack{{MID: "camera-mid", TrackName: "camera-track", Active: true}}}, nil
			}
			for _, current := range test.steps {
				t.Run(current.name, func(t *testing.T) {
					now = now.Add(current.advance)
					if current.presence != nil {
						repository.participants = current.presence
					}
					switch current.kind {
					case "fail":
						result, err := service.ConfirmRemoteTrackFailures(context.Background(), RemoteTrackFailureInput{
							TenantID: tenantID, EpisodeID: episodeID,
							ListenerParticipantID: current.listenerID, ListenerConnectionID: current.connectionID,
							Failed: []RemoteTrackIdentity{identity},
						}, reader)
						if err != nil {
							t.Fatalf("confirm listener failure: %v", err)
						}
						if current.wantWithdrawn && result.Closed != 1 {
							t.Fatalf("confirmation result=%+v, want withdrawal", result)
						}
						if !current.wantWithdrawn && result.Closed != 0 {
							t.Fatalf("confirmation result=%+v, want publication retained", result)
						}
						if result.Deduped != current.wantDeduped {
							t.Fatalf("deduped count=%d, want %d", result.Deduped, current.wantDeduped)
						}
					case "served":
						if err := service.ObserveRemoteTracks(context.Background(), RemoteTrackObservationInput{
							TenantID: tenantID, EpisodeID: episodeID,
							ListenerParticipantID: current.listenerID, ListenerConnectionID: current.connectionID,
							Requested: []RemoteTrackIdentity{identity},
						}); err != nil {
							t.Fatalf("record successful pull: %v", err)
						}
					default:
						t.Fatalf("unknown step kind %q", current.kind)
					}
					if readerCalls != current.wantReaderCalls {
						t.Fatalf("reader calls=%d, want %d", readerCalls, current.wantReaderCalls)
					}
					assertPublicationEnabled(t, repository.appended.Publications, publisherID, "camera", !current.wantWithdrawn)
				})
			}
		})
	}
}
