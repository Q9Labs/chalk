package media

import (
	"testing"
	"time"
)

// camera is a two-layer camera tile at its usual rates.
func camera(state *allocation) tile {
	return tile{layers: []layerRate{{rid: "h", bps: 1_200_000}, {rid: "l", bps: 300_000}}, state: state}
}

func estimateOf(current, proven float64) transportEstimate {
	return transportEstimate{warm: true, current: current, proven: proven}
}

func at(d time.Duration) int64 { return int64(time.Second + d) }

func TestANewPullStartsLowAndClimbsOnceTheRateIsProven(t *testing.T) {
	var state allocation
	tiles := []tile{camera(&state)}
	if probe := allocate(tiles, estimateOf(5e6, 5e6), 0, 0, at(0)); probe != 0 || state.rid != "l" {
		t.Fatalf("first decision rid %q probe %.0f, want l and no probe", state.rid, probe)
	}
	allocate(tiles, estimateOf(5e6, 5e6), 0, 0, at(100*time.Millisecond))
	if state.rid != "l" {
		t.Fatalf("raised to %q before the upgrade hold", state.rid)
	}
	allocate(tiles, estimateOf(5e6, 5e6), 0, 0, at(600*time.Millisecond))
	if state.rid != "h" {
		t.Fatalf("rid %q after the hold on a proven 5 Mbit/s path, want h", state.rid)
	}
}

func TestARaiseBeyondTheProvenRateAsksForAProbe(t *testing.T) {
	var state allocation
	tiles := []tile{camera(&state)}
	allocate(tiles, estimateOf(5e6, 500_000), 0, 0, at(0))
	probe := allocate(tiles, estimateOf(5e6, 500_000), 0, 0, at(time.Second))
	if state.rid != "l" {
		t.Fatalf("raised to %q on an unproven estimate", state.rid)
	}
	// h needs 1.2 Mbit/s; the probe asks for that with headroom.
	if want := 1_200_000 / allocHeadroom * probeMargin; probe < want*0.99 || probe > want*1.01 {
		t.Fatalf("probe target %.0f, want about %.0f", probe, want)
	}
}

func TestQualityDropsAtOnceAndRisesOnlyAfterABackoff(t *testing.T) {
	state := allocation{decided: true, rid: "h", backoff: backoffMin}
	tiles := []tile{camera(&state)}
	allocate(tiles, estimateOf(600_000, 600_000), 0, 0, at(0))
	if state.rid != "l" {
		t.Fatalf("rid %q on a 600 kbit/s estimate, want l at once", state.rid)
	}
	allocate(tiles, estimateOf(5e6, 5e6), 0, 0, at(time.Second))
	if state.rid != "l" {
		t.Fatal("raised again within the two-second backoff")
	}
	allocate(tiles, estimateOf(5e6, 5e6), 0, 0, at(2100*time.Millisecond))
	if state.rid != "h" {
		t.Fatalf("rid %q after the backoff, want h", state.rid)
	}
	// A second drop soon after doubles the backoff.
	allocate(tiles, estimateOf(600_000, 600_000), 0, 0, at(2200*time.Millisecond))
	allocate(tiles, estimateOf(5e6, 5e6), 0, 0, at(5*time.Second))
	if state.rid != "l" {
		t.Fatal("raised again within the doubled backoff")
	}
}

func TestATileBelowItsLowestLayerPausesAndResumesAfterTheEstimateHolds(t *testing.T) {
	state := allocation{decided: true, rid: "l", backoff: backoffMin}
	tiles := []tile{camera(&state)}
	// A brief shortfall keeps the lowest layer.
	allocate(tiles, estimateOf(250_000, 250_000), 0, 0, at(0))
	allocate(tiles, estimateOf(2e6, 2e6), 0, 0, at(500*time.Millisecond))
	allocate(tiles, estimateOf(250_000, 250_000), 0, 0, at(time.Second))
	allocate(tiles, estimateOf(250_000, 250_000), 0, 0, at(1900*time.Millisecond))
	if state.paused {
		t.Fatal("paused before one shortfall lasted the pause hold")
	}
	allocate(tiles, estimateOf(250_000, 250_000), 0, 0, at(2*time.Second))
	if !state.paused || state.limit() != (serverLimit{rid: "l", paused: true}) {
		t.Fatalf("state %+v after a second on a 250 kbit/s estimate, want paused", state)
	}
	// A brief recovery does not resume it.
	for step := range 20 {
		allocate(tiles, estimateOf(2e6, 2e6), 0, 0, at(2100*time.Millisecond+time.Duration(step)*100*time.Millisecond))
	}
	allocate(tiles, estimateOf(250_000, 250_000), 0, 0, at(4200*time.Millisecond))
	if !state.paused {
		t.Fatal("resumed before the estimate held for the resume hold")
	}
	start := 4300 * time.Millisecond
	for step := time.Duration(0); step < resumeHold; step += 100 * time.Millisecond {
		allocate(tiles, estimateOf(2e6, 2e6), 0, 0, at(start+step))
		if !state.paused {
			t.Fatalf("resumed after %v of fit, want %v", step, resumeHold)
		}
	}
	allocate(tiles, estimateOf(2e6, 2e6), 0, 0, at(start+resumeHold))
	if state.paused || state.rid != "l" {
		t.Fatalf("state %+v after the hold, want resumed on l", state)
	}
}

func TestALowestLayerThePathStillDeliversKeepsFlowing(t *testing.T) {
	state := allocation{decided: true, rid: "l", backoff: backoffMin}
	tiles := []tile{camera(&state)}
	delivering := estimateOf(250_000, 250_000)
	delivering.delivering = true
	for step := range 30 {
		allocate(tiles, delivering, 0, 0, at(time.Duration(step)*100*time.Millisecond))
	}
	if state.paused {
		t.Fatal("paused a layer the path delivers on an estimate below it")
	}
	// Once the path loses what it is sent, the shortfall has already lasted.
	allocate(tiles, estimateOf(250_000, 250_000), 0, 0, at(3*time.Second))
	if !state.paused {
		t.Fatal("kept a layer the path no longer delivers")
	}
}

func TestAPausedTileAsksForAProbeToResume(t *testing.T) {
	state := allocation{decided: true, rid: "l", paused: true, backoff: backoffMin}
	tiles := []tile{camera(&state)}
	if probe := allocate(tiles, estimateOf(2e6, 200_000), 0, 0, at(0)); probe == 0 {
		t.Fatal("a paused tile on an unproven estimate asked for no probe")
	}
}

func TestTheScreenAndTheLatestSpeakerKeepVideoLongest(t *testing.T) {
	var screen, speaker, quiet allocation
	tiles := []tile{
		{voiced: 0, order: 1, layers: camera(nil).layers, state: &quiet},
		{voiced: int64(time.Second), order: 2, layers: camera(nil).layers, state: &speaker},
		{screen: true, order: 3, layers: []layerRate{{bps: 1_000_000}}, state: &screen},
	}
	allocate(tiles, estimateOf(2e6, 2e6), 0, 0, at(0))
	// 0.95 x 1.5 Mbit/s leaves 1.425: the screen's 1.0, the speaker's 0.3, and no room for a third.
	allocate(tiles, estimateOf(1.5e6, 1.5e6), 0, 0, at(100*time.Millisecond))
	allocate(tiles, estimateOf(1.5e6, 1.5e6), 0, 0, at(100*time.Millisecond+pauseHold))
	if screen.paused || speaker.paused || !quiet.paused {
		t.Fatalf("screen paused %v, speaker paused %v, quiet paused %v; want only the quiet camera paused",
			screen.paused, speaker.paused, quiet.paused)
	}
}

func TestAudioAndRepairsComeOutOfTheVideoBudget(t *testing.T) {
	state := allocation{decided: true, rid: "l", backoff: backoffMin}
	tiles := []tile{camera(&state)}
	// 0.95 x 500 kbit/s carries the 300 kbit/s layer alone, but not with 100 of audio and 100 of repair.
	allocate(tiles, estimateOf(500_000, 500_000), 100_000, 100_000, at(0))
	allocate(tiles, estimateOf(500_000, 500_000), 100_000, 100_000, at(pauseHold))
	if !state.paused {
		t.Fatal("video kept its layer in the room audio and repairs use")
	}
}

func TestNothingPausesBeforeTheFirstFeedback(t *testing.T) {
	state := allocation{decided: true, rid: "h", backoff: backoffMin}
	tiles := []tile{camera(&state)}
	if probe := allocate(tiles, transportEstimate{current: 10_000, proven: 10_000}, 0, 0, at(0)); probe != 0 {
		t.Fatal("asked for a probe before any feedback")
	}
	if state.paused || state.rid != "h" {
		t.Fatalf("state %+v before any feedback, want it unchanged", state)
	}
}

func TestAnInactiveLayerIsNotACongestionDrop(t *testing.T) {
	state := allocation{decided: true, rid: "h", backoff: backoffMin}
	lowOnly := tile{layers: []layerRate{{rid: "l", bps: 300_000}}, state: &state}
	allocate([]tile{lowOnly}, estimateOf(5e6, 5e6), 0, 0, at(0))
	if state.rid != "h" || state.backoff != backoffMin {
		t.Fatalf("state %+v while h is inactive, want h kept without a backoff", state)
	}
}

func TestTheEpisodePlanLowersQuietCamerasFirst(t *testing.T) {
	quiet := &plannedCamera{order: 1, cost: [planLevels]float64{1000, 300, 0}}
	speaker := &plannedCamera{order: 2, voiced: 5, cost: [planLevels]float64{1000, 300, 0}}
	cameras := []*plannedCamera{speaker, quiet}
	// 500 base + 2,000 at the open level is over a 2,000 ceiling; capping the quiet camera fits.
	if !planEpisode(cameras, 500, 2000, false) || quiet.level != planLowest || speaker.level != planOpen {
		t.Fatalf("levels quiet %d speaker %d, want 1 and 0", quiet.level, speaker.level)
	}
	// A tighter ceiling caps the speaker too, then pauses the quiet camera.
	if !planEpisode(cameras, 500, 900, false) || quiet.level != planPaused || speaker.level != planLowest {
		t.Fatalf("levels quiet %d speaker %d at 900, want 2 and 1", quiet.level, speaker.level)
	}
	// Raising waits for the hold, then frees the speaker's step first, into room below the ceiling.
	if planEpisode(cameras, 500, 5000, false) {
		t.Fatal("raised before the hold")
	}
	if !planEpisode(cameras, 500, 1300, true) || quiet.level != planLowest || speaker.level != planLowest {
		t.Fatalf("levels quiet %d speaker %d after one raise, want the paused camera back first", quiet.level, speaker.level)
	}
	if planEpisode(cameras, 500, 1500, true) {
		t.Fatal("raised the speaker to 1,800 packets/s, above 90% of a 1,500 ceiling")
	}
	if !planEpisode(cameras, 500, 5000, true) || speaker.level != planOpen || quiet.level != planLowest {
		t.Fatalf("levels quiet %d speaker %d, want the speaker raised first", quiet.level, speaker.level)
	}
}
