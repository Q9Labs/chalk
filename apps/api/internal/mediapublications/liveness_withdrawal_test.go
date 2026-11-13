package mediapublications

import (
	"context"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

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
				{name: "repeat failure", advance: stuckFor, listenerID: listenerA, connectionID: "a", kind: "fail", presence: presence(listener(listenerA, "a")), wantWithdrawn: true, wantReaderCalls: 2},
			},
		},
		{
			name: "not_found_track_error for a single present listener",
			steps: []step{
				{name: "first missing-publication report", listenerID: listenerA, connectionID: "a", kind: "fail", presence: presence(listener(listenerA, "a")), wantReaderCalls: 1},
				{name: "repeated missing-publication report", advance: stuckFor, listenerID: listenerA, connectionID: "a", kind: "fail", presence: presence(listener(listenerA, "a")), wantWithdrawn: true, wantReaderCalls: 2},
			},
		},
		{
			name: "failing listener left before the threshold",
			steps: []step{
				{name: "A fails on a1", listenerID: listenerA, connectionID: "a1", kind: "fail", presence: presence(listener(listenerA, "a1")), wantReaderCalls: 1},
				{name: "B fails for the first time after A leaves", advance: stuckFor, listenerID: listenerB, connectionID: "b1", kind: "fail", presence: presence(listener(listenerB, "b1")), wantReaderCalls: 2},
			},
		},
		{
			name: "failing listener reconnected before the threshold",
			steps: []step{
				{name: "A fails on a1", listenerID: listenerA, connectionID: "a1", kind: "fail", presence: presence(listener(listenerA, "a1")), wantReaderCalls: 1},
				{name: "B fails while A is present on a2", advance: stuckFor, listenerID: listenerB, connectionID: "b1", kind: "fail", presence: presence(listener(listenerA, "a2"), listener(listenerB, "b1")), wantReaderCalls: 2},
			},
		},
		{
			name: "reconnected listener's new failure restarts its window",
			steps: []step{
				{name: "A fails on a1", listenerID: listenerA, connectionID: "a1", kind: "fail", presence: presence(listener(listenerA, "a1")), wantReaderCalls: 1},
				{name: "A fails on a2 after reconnecting", advance: stuckFor, listenerID: listenerA, connectionID: "a2", kind: "fail", presence: presence(listener(listenerA, "a2")), wantReaderCalls: 2},
			},
		},
		{
			name: "listener who left",
			steps: []step{
				{name: "listener B served", listenerID: listenerB, connectionID: "b", kind: "served", presence: presence(listener(listenerB, "b"))},
				{name: "A first failure", advance: time.Second, listenerID: listenerA, connectionID: "a", kind: "fail", presence: presence(listener(listenerA, "a")), wantReaderCalls: 1},
				{name: "A repeat failure", advance: stuckFor, listenerID: listenerA, connectionID: "a", kind: "fail", presence: presence(listener(listenerA, "a")), wantWithdrawn: true, wantReaderCalls: 2},
			},
		},
		{
			name: "listener whose media connection changed",
			steps: []step{
				{name: "B served on b1", listenerID: listenerB, connectionID: "b1", kind: "served", presence: presence(listener(listenerB, "b1"))},
				{name: "A first failure", advance: time.Second, listenerID: listenerA, connectionID: "a", kind: "fail", presence: presence(listener(listenerA, "a"), listener(listenerB, "b2")), wantReaderCalls: 1},
				{name: "A repeat failure", advance: stuckFor, listenerID: listenerA, connectionID: "a", kind: "fail", presence: presence(listener(listenerA, "a"), listener(listenerB, "b2")), wantWithdrawn: true, wantReaderCalls: 2},
			},
		},
		{
			name: "two listeners failing within the dedupe window",
			steps: []step{
				{name: "B served", listenerID: listenerB, connectionID: "b", kind: "served", presence: presence(listener(listenerA, "a"), listener(listenerB, "b"))},
				{name: "A fails", advance: time.Second, listenerID: listenerA, connectionID: "a", kind: "fail", wantReaderCalls: 1},
				{name: "B fails while the reader is deduped", advance: 500 * time.Millisecond, listenerID: listenerB, connectionID: "b", kind: "fail", wantReaderCalls: 1, wantDeduped: 1},
				{name: "A repeats after the grace", advance: stuckFor, listenerID: listenerA, connectionID: "a", kind: "fail", wantWithdrawn: true, wantReaderCalls: 2},
			},
		},
		{
			name: "fail then succeed then fail",
			steps: []step{
				{name: "first failure", listenerID: listenerA, connectionID: "a", kind: "fail", presence: presence(listener(listenerA, "a")), wantReaderCalls: 1},
				{name: "successful pull", advance: time.Second, listenerID: listenerA, connectionID: "a", kind: "served", wantReaderCalls: 1},
				{name: "failure after success", advance: 1500 * time.Millisecond, listenerID: listenerA, connectionID: "a", kind: "fail", wantReaderCalls: 2},
				{name: "repeat after the new failure", advance: stuckFor, listenerID: listenerA, connectionID: "a", kind: "fail", wantWithdrawn: true, wantReaderCalls: 3},
			},
		},
		{
			name: "one broken listener while others are served",
			steps: []step{
				{name: "B served", listenerID: listenerB, connectionID: "b", kind: "served", presence: presence(listener(listenerA, "a"), listener(listenerB, "b"))},
				{name: "A first failure", advance: time.Second, listenerID: listenerA, connectionID: "a", kind: "fail", wantReaderCalls: 1},
				{name: "A repeat failure", advance: stuckFor, listenerID: listenerA, connectionID: "a", kind: "fail", wantReaderCalls: 2},
				{name: "A keeps failing", advance: stuckFor, listenerID: listenerA, connectionID: "a", kind: "fail", wantReaderCalls: 3},
			},
		},
		{
			name: "served evidence expires",
			steps: []step{
				{name: "B served", listenerID: listenerB, connectionID: "b", kind: "served", presence: presence(listener(listenerA, "a"), listener(listenerB, "b"))},
				{name: "A first failure after expiry", advance: 31 * time.Second, listenerID: listenerA, connectionID: "a", kind: "fail", wantReaderCalls: 1},
				{name: "A repeat failure", advance: stuckFor, listenerID: listenerA, connectionID: "a", kind: "fail", wantWithdrawn: true, wantReaderCalls: 2},
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
