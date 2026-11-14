package captureplane

import "testing"

func TestTrackLayerRIDsAreTheSimulcastIDs(t *testing.T) {
	for layer, want := range map[TrackLayer]string{TrackLayerHigh: "h", TrackLayerMedium: "m", TrackLayerLow: "l", TrackLayerAuto: ""} {
		if got := layer.RID(); got != want {
			t.Errorf("%s RID = %q, want %q", layer, got, want)
		}
	}
}
