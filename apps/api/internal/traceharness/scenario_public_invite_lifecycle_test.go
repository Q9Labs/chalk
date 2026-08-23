package traceharness

import (
	"context"
	"net/http"
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
	assertEvent(t, result.Events, "repository", "PublicInviteRepository.ListDueAutoLifecycles")
	assertEvent(t, result.Events, "adapter", "EpisodeLifecycle.EndEpisode")
	assertEvent(t, result.Events, "adapter", "SpaceLifecycle.ArchiveSpace")
}
