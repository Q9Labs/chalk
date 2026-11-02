package mediapublications

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

type pullHoldFixture struct {
	t        *testing.T
	service  Service
	clock    time.Time
	identity RemoteTrackIdentity
	reads    int
	// activeAfter is the number of session reads that list the track as inactive.
	activeAfter int
	readErr     error
	notFound    bool
}

func newPullHoldFixture(t *testing.T, config PullHoldConfig) *pullHoldFixture {
	t.Helper()
	fixture := &pullHoldFixture{t: t, clock: time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)}
	repository := &reconciliationRepositoryStub{}
	fixture.service = newService(repository, func() time.Time { return fixture.clock }).WithPullHold(config)
	_, _, _, fixture.identity = publishRemoteObservationFixture(t, fixture.service, repository)
	if fixture.service.pullHold != nil {
		fixture.service.pullHold.sleep = func(_ context.Context, d time.Duration) { fixture.clock = fixture.clock.Add(d) }
	}
	return fixture
}

func (f *pullHoldFixture) read(_ context.Context, connectionID string) (PublisherSession, error) {
	f.t.Helper()
	if connectionID != f.identity.ConnectionID {
		f.t.Fatalf("session read for %q, want %q", connectionID, f.identity.ConnectionID)
	}
	f.reads++
	if f.readErr != nil {
		return PublisherSession{}, f.readErr
	}
	if f.notFound {
		return PublisherSession{}, nil
	}
	return PublisherSession{Found: true, Tracks: []PublisherTrack{{MID: "camera-mid", TrackName: f.identity.TrackName, Active: f.reads > f.activeAfter}}}, nil
}

func (f *pullHoldFixture) hold() PullHoldResult {
	return f.service.HoldRemotePulls(context.Background(), []RemoteTrackIdentity{f.identity}, f.read)
}

var enabledPullHold = PullHoldConfig{Enabled: true, Budget: 4 * time.Second}

func TestPullHoldWaitsUntilTheTrackIsActive(t *testing.T) {
	fixture := newPullHoldFixture(t, enabledPullHold)
	fixture.activeAfter = 3

	result := fixture.hold()

	if !result.Held || result.Outcome != pullHoldOutcomeActive || fixture.reads != 4 || result.Waited != 3*pullHoldPollInterval {
		t.Fatalf("result=%+v reads=%d, want a hold released by the fourth read after 600 ms", result, fixture.reads)
	}
}

func TestPullHoldForwardsAfterTheBudget(t *testing.T) {
	fixture := newPullHoldFixture(t, PullHoldConfig{Enabled: true, Budget: time.Second})
	fixture.activeAfter = 1 << 30

	result := fixture.hold()

	if !result.Held || result.Outcome != pullHoldOutcomeBudgetExpired || result.Waited < time.Second || result.Waited > time.Second+pullHoldPollInterval {
		t.Fatalf("result=%+v, want budget expiry after about 1 s", result)
	}
	if fixture.reads != 5 {
		t.Fatalf("reads=%d, want one read per 200 ms poll until the budget", fixture.reads)
	}
}

func TestPullHoldAddsNoCloudflareCallForActiveOrOldPublications(t *testing.T) {
	fixture := newPullHoldFixture(t, enabledPullHold)
	if result := fixture.hold(); result.Outcome != pullHoldOutcomeActive || fixture.reads != 1 {
		t.Fatalf("first pull result=%+v reads=%d, want one read that finds the track active", result, fixture.reads)
	}

	if result := fixture.hold(); result.Held || fixture.reads != 1 {
		t.Fatalf("second pull result=%+v reads=%d, want no further read once cached active", result, fixture.reads)
	}

	other := RemoteTrackIdentity{ConnectionID: fixture.identity.ConnectionID, TrackName: "never-published-here"}
	if result := fixture.service.HoldRemotePulls(context.Background(), []RemoteTrackIdentity{other}, fixture.read); result.Held || fixture.reads != 1 {
		t.Fatalf("unknown track result=%+v reads=%d, want no hold", result, fixture.reads)
	}
}

func TestPullHoldIgnoresPublicationsOlderThanTheYoungWindow(t *testing.T) {
	fixture := newPullHoldFixture(t, enabledPullHold)
	fixture.clock = fixture.clock.Add(pullHoldYoungWindow)

	if result := fixture.hold(); result.Held || fixture.reads != 0 {
		t.Fatalf("result=%+v reads=%d, want no read for an old publication", result, fixture.reads)
	}
}

func TestPullHoldPublishingAgainRestartsTheHold(t *testing.T) {
	fixture := newPullHoldFixture(t, enabledPullHold)
	fixture.hold()
	reads := fixture.reads

	fixture.service.pullHold.notePublished(fixture.identity.ConnectionID, []string{fixture.identity.TrackName})
	fixture.hold()

	if fixture.reads != reads+1 {
		t.Fatalf("reads=%d, want one more read after the track was published again", fixture.reads)
	}
}

func TestPullHoldForwardsAtOnceWhenCloudflareCannotAnswer(t *testing.T) {
	for _, test := range []struct {
		name    string
		err     error
		missing bool
		want    pullHoldOutcome
	}{
		{name: "session read fails", err: errors.New("cloudflare unavailable"), want: pullHoldOutcomeReadFailed},
		{name: "publisher session is gone", missing: true, want: pullHoldOutcomeSessionMissing},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newPullHoldFixture(t, enabledPullHold)
			fixture.readErr, fixture.notFound = test.err, test.missing

			result := fixture.hold()

			if result.Outcome != test.want || fixture.reads != 1 || result.Waited != 0 {
				t.Fatalf("result=%+v reads=%d, want %s after one read", result, fixture.reads, test.want)
			}
		})
	}
}

func TestPullHoldStopsWhenTheRequestIsCancelled(t *testing.T) {
	fixture := newPullHoldFixture(t, enabledPullHold)
	fixture.activeAfter = 1 << 30
	ctx, cancel := context.WithCancel(context.Background())
	fixture.service.pullHold.sleep = func(context.Context, time.Duration) { cancel() }

	result := fixture.service.HoldRemotePulls(ctx, []RemoteTrackIdentity{fixture.identity}, fixture.read)

	if result.Outcome != pullHoldOutcomeCancelled || fixture.reads != 1 {
		t.Fatalf("result=%+v reads=%d, want a cancelled hold after one read", result, fixture.reads)
	}
}

func TestPullHoldOffChangesNothing(t *testing.T) {
	for _, config := range []PullHoldConfig{{}, {Enabled: false, Budget: time.Second}, {Enabled: true}} {
		fixture := newPullHoldFixture(t, config)
		if fixture.service.pullHold != nil {
			t.Fatalf("config %+v created a hold", config)
		}

		if result := fixture.hold(); result.Held || fixture.reads != 0 {
			t.Fatalf("config %+v result=%+v reads=%d, want no hold and no Cloudflare read", config, result, fixture.reads)
		}
	}
}

func TestPullHoldRecordsAreBounded(t *testing.T) {
	hold := newPullHold(enabledPullHold, time.Now)
	for index := 0; index < 2*pullHoldMaxEntries; index++ {
		hold.notePublished("connection", []string{fmt.Sprintf("track-%d", index)})
	}
	if len(hold.entries) > pullHoldMaxEntries {
		t.Fatalf("entries=%d, want at most %d", len(hold.entries), pullHoldMaxEntries)
	}
}
