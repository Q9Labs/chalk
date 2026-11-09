package chalksfu

import "testing"

// The join advertises the single signalling URL only while the deployment flag is on,
// so turning the flag off sends every SDK back to the per-operation routes.
func TestJoinAdvertisesUnifiedSignalingOnlyWhenConfigured(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		join := (&Adapter{unifiedSignaling: enabled}).join("episode-ref", "participant-ref", "connection-1", nil)
		capabilities, _ := join.ClientPayload["capabilities"].(map[string]any)
		if capabilities["unifiedSignaling"] != enabled {
			t.Errorf("flag %v advertised unifiedSignaling %v in %v", enabled, capabilities["unifiedSignaling"], capabilities)
		}
		if capabilities["iceRestart"] != true {
			t.Errorf("the existing capabilities changed: %v", capabilities)
		}
	}
}
