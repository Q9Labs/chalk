package traceharness

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestRunServiceDashboardSpaceJoinScenario(t *testing.T) {
	result, err := Run(context.Background(), ServiceDashboardSpaceJoinScenario)
	if err != nil {
		t.Fatalf("%v; body=%s events=%#v", err, result.Body, result.Events)
	}
	if result.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", result.StatusCode, http.StatusOK)
	}

	var body struct {
		EpisodeCreated         bool   `json:"episode_created"`
		EpisodeDurable         bool   `json:"episode_durable"`
		ObserverNotifications  int    `json:"observer_notifications"`
		ReusedEpisode          bool   `json:"reused_episode"`
		ReusedEpisodeCreated   bool   `json:"reused_episode_created"`
		StartTime              string `json:"start_time"`
		StartTimeAuthoritative bool   `json:"start_time_authoritative"`
	}
	if err := json.Unmarshal(result.Body, &body); err != nil {
		t.Fatalf("decode result body: %v", err)
	}
	if !body.EpisodeCreated || !body.EpisodeDurable || body.StartTime == "" || !body.StartTimeAuthoritative {
		t.Fatalf("created Episode proof = %#v", body)
	}
	if !body.ReusedEpisode || body.ReusedEpisodeCreated || body.ObserverNotifications != 1 {
		t.Fatalf("Episode reuse proof = %#v", body)
	}

	assertEvent(t, result.Events, "database", "INSERT episodes")
	assertEvent(t, result.Events, "database", "COMMIT")
	assertEvent(t, result.Events, "observer", "episodes.CommitObserver.EpisodeCommitted")
	if countEvents(result.Events, "observer", "episodes.CommitObserver.EpisodeCommitted") != 1 {
		t.Fatalf("observer notifications in trace = %d, want 1", countEvents(result.Events, "observer", "episodes.CommitObserver.EpisodeCommitted"))
	}
}

func TestServiceDashboardSpaceJoinScenarioIsCatalogued(t *testing.T) {
	for _, name := range ScenarioNames() {
		if name == ServiceDashboardSpaceJoinScenario {
			return
		}
	}
	t.Fatalf("scenario %q is missing from the catalog", ServiceDashboardSpaceJoinScenario)
}

func countEvents(events []Event, layer, operation string) int {
	count := 0
	for _, event := range events {
		if event.Layer == layer && event.Operation == operation {
			count++
		}
	}
	return count
}
