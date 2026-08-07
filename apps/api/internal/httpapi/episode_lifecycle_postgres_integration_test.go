package httpapi

import (
	"net/http"
	"testing"
)

func TestEpisodeLifecycleRouteContractUsesPluralEpisodeSurface(t *testing.T) {
	want := map[string]string{
		"createEpisode":                    http.MethodPost + " /v1/tenants/{tenant_id}/spaces/{space_id}/episodes",
		"listEpisodes":                     http.MethodGet + " /v1/tenants/{tenant_id}/spaces/{space_id}/episodes",
		"getEpisode":                       http.MethodGet + " /v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}",
		"admitEpisodeParticipant":          http.MethodPost + " /v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants",
		"issueEpisodeParticipantSyncToken": http.MethodPost + " /v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/sync-token",
		"issueAccessGrant":                 http.MethodPost + " /v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/access-grant",
		"removeEpisodeParticipant":         http.MethodPost + " /v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/remove",
		"setEpisodeDeadline":               http.MethodPost + " /v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/deadline",
		"endEpisode":                       http.MethodPost + " /v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/end",
	}
	seen := make(map[string]bool)
	for _, endpoint := range episodeLifecycleEndpoints(nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil) {
		contract := endpoint.RouteContract()
		key := contract.OperationID
		if want[key] != contract.Method+" "+contract.Path {
			t.Fatalf("unexpected route %q: %s %s", key, contract.Method, contract.Path)
		}
		seen[key] = true
	}
	for operation := range want {
		if !seen[operation] {
			t.Fatalf("missing route %q", operation)
		}
	}
}
