package postgres

import "testing"

func TestLiveParticipantsCountsOnlyUnexpiredPresenceLeases(t *testing.T) {
	f := newSchedulerFixture(t)
	before := f.count(liveParticipantsQuery)
	f.episode("now() + interval '1 hour'", 2, false)
	f.episode("now() + interval '1 hour'", 3, true)
	if got := f.count(liveParticipantsQuery) - before; got != 2 {
		t.Fatalf("live participants grew by %d, want 2 (expired leases must not count)", got)
	}
}
