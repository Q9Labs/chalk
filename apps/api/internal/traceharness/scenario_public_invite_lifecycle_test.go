package traceharness

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"testing"
)

func TestRunServicePublicInviteLifecycleScenario(t *testing.T) {
	result, err := Run(context.Background(), ServicePublicInviteLifecycleScenario)
	if err != nil {
		t.Fatalf("run scenario: %v; events=%#v", err, result.Events)
	}
	if result.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", result.StatusCode, http.StatusOK)
	}
	body := struct {
		ActiveParticipantsWaited bool     `json:"active_participants_waited"`
		FinalParticipantArchived bool     `json:"final_participant_archived"`
		EndEpisodeBeforeArchive  []string `json:"end_episode_before_archive"`
	}{}
	if err := json.Unmarshal(result.Body, &body); err != nil {
		t.Fatalf("decode scenario body: %v", err)
	}
	if !body.ActiveParticipantsWaited {
		t.Fatal("scenario did not wait for the active Participant")
	}
	if !body.FinalParticipantArchived {
		t.Fatal("scenario did not archive after the final Participant left")
	}
	if !slices.Equal(body.EndEpisodeBeforeArchive, []string{"end_episode", "archive_space"}) {
		t.Fatalf("lifecycle actions = %v", body.EndEpisodeBeforeArchive)
	}

	hasEvent := func(layer, operation string) bool {
		return slices.ContainsFunc(result.Events, func(event Event) bool {
			return event.Layer == layer && event.Operation == operation
		})
	}
	for _, expected := range [][2]string{
		{"repository", "PublicInviteRepository.ListDueAutoLifecycles"},
		{"adapter", "EpisodeLifecycle.EndEpisode"},
		{"adapter", "SpaceLifecycle.ArchiveSpace"},
	} {
		if !hasEvent(expected[0], expected[1]) {
			t.Fatalf("missing %s event %q", expected[0], expected[1])
		}
	}
}
