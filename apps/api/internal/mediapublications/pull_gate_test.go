package mediapublications

import (
	"context"
	"errors"
	"testing"
	"time"
)

// Cloudflare keeps a track unpullable for 79 s or more when a pull lands before its publisher's
// peer connection is up. The gate must hold every pull until the publisher is confirmed or old enough.
type pullGateFixture struct {
	service Service
	now     time.Time
	waited  []time.Duration
}

func newPullGateFixture(t *testing.T) *pullGateFixture {
	t.Helper()
	fixture := &pullGateFixture{now: time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC)}
	fixture.service = newService(&reconciliationRepositoryStub{}, func() time.Time { return fixture.now })
	fixture.service.pullGate.wait = func(_ context.Context, duration time.Duration, _ <-chan struct{}) error {
		fixture.waited = append(fixture.waited, duration)
		fixture.now = fixture.now.Add(duration)
		return nil
	}
	return fixture
}

func (f *pullGateFixture) publish(t *testing.T, connectionID, trackName string) RemoteTrackIdentity {
	t.Helper()
	_, err := f.service.RecordPublishedTracks(context.Background(), RecordInput{
		TenantID:  reconciliationTestID(t, "11111111-1111-4111-8111-111111111111"),
		EpisodeID: reconciliationTestID(t, "22222222-2222-4222-8222-222222222222"), ParticipantID: reconciliationTestID(t, "33333333-3333-4333-8333-333333333333"),
		ParticipantGeneration: 1, ConnectionID: connectionID, Tracks: []PublishedTrack{{Source: "microphone", MID: "0", TrackName: trackName}},
	})
	if err != nil {
		t.Fatalf("publish %s: %v", trackName, err)
	}
	return RemoteTrackIdentity{ConnectionID: connectionID, TrackName: trackName}
}

func TestAwaitPullableHoldsAPullUntilTheFallbackAge(t *testing.T) {
	fixture := newPullGateFixture(t)
	identity := fixture.publish(t, "publisher-1", "microphone-a")
	fixture.now = fixture.now.Add(time.Second)

	if err := fixture.service.AwaitPullable(context.Background(), []RemoteTrackIdentity{identity}); err != nil {
		t.Fatalf("await pullable: %v", err)
	}
	if len(fixture.waited) != 1 || fixture.waited[0] != publisherConnectFallbackAge-time.Second {
		t.Fatalf("pull must wait for the rest of the fallback age, waited %v", fixture.waited)
	}
	if err := fixture.service.AwaitPullable(context.Background(), []RemoteTrackIdentity{identity}); err != nil || len(fixture.waited) != 1 {
		t.Fatalf("a second pull of an old publication must not wait: waited=%v error=%v", fixture.waited, err)
	}
}

func TestAwaitPullableReleasesWhenThePublisherConfirmsItsConnection(t *testing.T) {
	fixture := newPullGateFixture(t)
	identity := fixture.publish(t, "publisher-1", "microphone-a")

	fixture.service.ConfirmPublisherConnected("publisher-1")

	if err := fixture.service.AwaitPullable(context.Background(), []RemoteTrackIdentity{identity}); err != nil || len(fixture.waited) != 0 {
		t.Fatalf("a confirmed publisher must not hold pulls: waited=%v error=%v", fixture.waited, err)
	}
}

func TestAwaitPullableDoesNotHoldTracksItNeverSaw(t *testing.T) {
	fixture := newPullGateFixture(t)

	err := fixture.service.AwaitPullable(context.Background(), []RemoteTrackIdentity{{ConnectionID: "another-instance", TrackName: "microphone-z"}})

	if err != nil || len(fixture.waited) != 0 {
		t.Fatalf("an unknown track must be pulled at once: waited=%v error=%v", fixture.waited, err)
	}
}

func TestAwaitPullableWaitsOnlyForTheNewestPendingTrackInABatch(t *testing.T) {
	fixture := newPullGateFixture(t)
	older := fixture.publish(t, "publisher-1", "microphone-a")
	fixture.now = fixture.now.Add(2 * time.Second)
	newer := fixture.publish(t, "publisher-2", "microphone-b")

	if err := fixture.service.AwaitPullable(context.Background(), []RemoteTrackIdentity{older, newer}); err != nil {
		t.Fatalf("await pullable: %v", err)
	}
	if len(fixture.waited) != 1 || fixture.waited[0] != publisherConnectFallbackAge {
		t.Fatalf("batch must wait once for the newest track, waited %v", fixture.waited)
	}
}

func TestAwaitPullableStopsWhenTheRequestEnds(t *testing.T) {
	fixture := newPullGateFixture(t)
	identity := fixture.publish(t, "publisher-1", "microphone-a")
	fixture.service.pullGate.wait = func(_ context.Context, _ time.Duration, _ <-chan struct{}) error { return context.Canceled }

	err := fixture.service.AwaitPullable(context.Background(), []RemoteTrackIdentity{identity})

	if !errors.Is(err, context.Canceled) {
		t.Fatalf("a cancelled request must stop waiting, got %v", err)
	}
}

func TestPullGateForgetsPublicationsOnceTheyAreOldEnough(t *testing.T) {
	fixture := newPullGateFixture(t)
	for index := 0; index < 3; index++ {
		fixture.publish(t, "publisher-"+string(rune('a'+index)), "microphone")
	}
	fixture.now = fixture.now.Add(publisherConnectFallbackAge + time.Second)
	fixture.publish(t, "publisher-new", "microphone")

	if pending := fixture.service.pullGate.pendingCount(); pending != 1 {
		t.Fatalf("only the new publication may stay pending, got %d", pending)
	}
}

func TestAwaitPullableDoesNotHoldATrackAddedToAnOldConnection(t *testing.T) {
	fixture := newPullGateFixture(t)
	fixture.publish(t, "publisher-1", "microphone-a")
	fixture.now = fixture.now.Add(publisherConnectFallbackAge + time.Second)
	camera := fixture.publish(t, "publisher-1", "camera-a")

	if err := fixture.service.AwaitPullable(context.Background(), []RemoteTrackIdentity{camera}); err != nil || len(fixture.waited) != 0 {
		t.Fatalf("a second track rides the connected peer connection: waited=%v error=%v", fixture.waited, err)
	}
}

func TestAwaitPullableDoesNotHoldATrackAddedAfterTheConnectionWasConfirmed(t *testing.T) {
	fixture := newPullGateFixture(t)
	fixture.publish(t, "publisher-1", "microphone-a")
	fixture.service.ConfirmPublisherConnected("publisher-1")
	camera := fixture.publish(t, "publisher-1", "camera-a")

	if err := fixture.service.AwaitPullable(context.Background(), []RemoteTrackIdentity{camera}); err != nil || len(fixture.waited) != 0 {
		t.Fatalf("a confirmed connection stays pullable: waited=%v error=%v", fixture.waited, err)
	}
}
