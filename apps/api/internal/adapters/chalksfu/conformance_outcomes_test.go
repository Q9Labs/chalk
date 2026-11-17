package chalksfu_test

import (
	"context"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// requireEpisodeEndReportsSessions ends the Episode and checks the node says how each named
// connection (mapped to its Participant) ended.
func requireEpisodeEndReportsSessions(ctx context.Context, t *testing.T, box *sfu, episode string, participants map[string]string) {
	t.Helper()
	ended, err := box.adapter(t, box.ca, clientIdentity).EndEpisodeSessions(ctx, mediaplane.EndEpisodeInput{Provider: mediaplane.ProviderChalkSFU, TenantID: "tenant-1", EpisodeRef: episode})
	if err != nil {
		t.Fatalf("end Episode: %v", err)
	}
	byConnection := map[string]mediaplane.SessionOutcome{}
	for _, outcome := range ended {
		byConnection[outcome.ConnectionID] = outcome
	}
	for connection, participant := range participants {
		outcome, ok := byConnection[connection]
		if !ok || outcome.ParticipantRef != participant || outcome.Cause != "episode_ended" || outcome.Outcome == "" || outcome.EndedAt.IsZero() {
			t.Fatalf("outcome of %s = %+v (found %v)", participant, outcome, ok)
		}
	}
}
