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

// The direct door is advertised only while CHALK_API_DIRECT_URL is set; unset leaves the field out.
func TestJoinAdvertisesDirectSignalingOnlyWhenConfigured(t *testing.T) {
	join := (&Adapter{directSignalingURL: "https://direct.chalk.test"}).join("episode-ref", "participant-ref", "connection-1", nil)
	capabilities, _ := join.ClientPayload["capabilities"].(map[string]any)
	if capabilities["directSignalingUrl"] != "https://direct.chalk.test" {
		t.Errorf("configured: capabilities %v", capabilities)
	}
	join = (&Adapter{}).join("episode-ref", "participant-ref", "connection-1", nil)
	capabilities, _ = join.ClientPayload["capabilities"].(map[string]any)
	if _, present := capabilities["directSignalingUrl"]; present {
		t.Errorf("unset: capabilities %v", capabilities)
	}
}
