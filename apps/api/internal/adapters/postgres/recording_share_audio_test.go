package postgres

import (
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"testing"
)

func TestRecordingPlanExcludesSharedTabAudio(t *testing.T) {
	tracks, err := capturePlanTracks([]persistedCapturePlanPublication{{Source: "screen_audio", Enabled: true}}, map[utilities.ID]int64{})
	if err != nil || len(tracks) != 0 {
		t.Fatalf("share audio must not enter recording plans: tracks=%+v err=%v", tracks, err)
	}
}
