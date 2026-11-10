package httpapi

import (
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
)

func TestAccessGrantAdvertisesUnifiedSignaling(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		payload := publicAccessClientPayload(publicinvites.PublicAccessGrant{
			Provider: publicinvites.PublicProviderChalkSFU,
			ClientPayload: publicinvites.PublicAccessClientPayload{
				ConnectionID: "connection-1", EpisodeRef: "episode-ref",
				Capabilities: publicinvites.PublicAccessCapabilities{ICERestart: true, UnifiedSignaling: enabled},
			},
		})
		capabilities, _ := payload["capabilities"].(map[string]any)
		if capabilities["unifiedSignaling"] != enabled || capabilities["iceRestart"] != true {
			t.Errorf("flag %v produced capabilities %v", enabled, capabilities)
		}
	}
}
