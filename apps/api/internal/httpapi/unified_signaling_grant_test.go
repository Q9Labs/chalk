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

func TestAccessGrantAdvertisesDirectSignalingURLOnlyWhenSet(t *testing.T) {
	for _, url := range []string{"https://direct.chalk.test", ""} {
		payload := publicAccessClientPayload(publicinvites.PublicAccessGrant{
			Provider: publicinvites.PublicProviderChalkSFU,
			ClientPayload: publicinvites.PublicAccessClientPayload{
				ConnectionID: "connection-1", EpisodeRef: "episode-ref",
				Capabilities: publicinvites.PublicAccessCapabilities{DirectSignalingURL: url},
			},
		})
		capabilities, _ := payload["capabilities"].(map[string]any)
		got, present := capabilities["directSignalingUrl"]
		if (url == "") == present || (present && got != url) {
			t.Errorf("url %q produced capabilities %v", url, capabilities)
		}
	}
}
