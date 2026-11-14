package publicinviteapp

import (
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// The Chalk SFU's unifiedSignaling flag reaches the client payload of an access grant unchanged.
func TestPublicJoinPayloadCarriesUnifiedSignaling(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		join := mediaplane.Join{Provider: mediaplane.ProviderChalkSFU, ClientPayload: map[string]any{
			"connectionId": "connection-1",
			"episodeRef":   "episode-ref",
			"capabilities": map[string]any{"serverLayerAdaptation": true, "subscriptionState": true, "iceRestart": true, "unifiedSignaling": enabled},
		}}
		_, payload, err := publicJoinPayload(mediaplane.ProviderChalkSFU, join)
		if err != nil {
			t.Fatal(err)
		}
		if payload.Capabilities.UnifiedSignaling != enabled || !payload.Capabilities.ICERestart {
			t.Errorf("flag %v produced capabilities %+v", enabled, payload.Capabilities)
		}
	}
}

// The direct door reaches the client payload of an access grant unchanged, and stays out when unset.
func TestPublicJoinPayloadCarriesDirectSignalingURL(t *testing.T) {
	for _, flags := range []map[string]any{{"iceRestart": true, "directSignalingUrl": "https://direct.chalk.test"}, {"iceRestart": true}} {
		join := mediaplane.Join{Provider: mediaplane.ProviderChalkSFU, ClientPayload: map[string]any{"connectionId": "connection-1", "episodeRef": "episode-ref", "capabilities": flags}}
		_, payload, err := publicJoinPayload(mediaplane.ProviderChalkSFU, join)
		want, _ := flags["directSignalingUrl"].(string)
		if err != nil || payload.Capabilities.DirectSignalingURL != want {
			t.Errorf("flags %v: url %q, err %v", flags, payload.Capabilities.DirectSignalingURL, err)
		}
	}
}
