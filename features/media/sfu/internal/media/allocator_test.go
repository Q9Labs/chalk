package media

import (
	"testing"
	"time"
)

// camera is a two-layer camera tile at its usual rates.
func camera(state *allocation) tile {
	return tile{layers: []layerRate{{rid: "h", bps: 1_200_000}, {rid: "l", bps: 300_000}}, state: state}
}

// estimateOf is the estimate of a path that loses what it is sent.
func estimateOf(current, proven float64) transportEstimate {
	return transportEstimate{warm: true, current: current, proven: proven, lossy: true}
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

func TestAByteShortfallWithoutHeavyPacketLossDoesNotPause(t *testing.T) {
	state := allocation{decided: true, rid: "l", backoff: backoffMin}
	tiles := []tile{camera(&state)}
	quiet := estimateOf(250_000, 250_000)
	quiet.lossy = false
	for step := range 100 {
		allocate(tiles, quiet, 0, 0, at(time.Duration(step)*100*time.Millisecond))
	}
	if state.paused {
		t.Fatal("paused a layer on a byte shortfall alone, with no heavy packet loss reported")
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

func TestAPausedTileWaitsOutItsDropBackoffBeforeResuming(t *testing.T) {
	// Pauses in quick succession have doubled the hold after the latest one to 8 s.
	state := allocation{decided: true, rid: "l", paused: true, backoff: backoffMax, holdUntil: at(8 * time.Second)}
	tiles := []tile{camera(&state)}
	for step := time.Duration(0); step < 8*time.Second; step += 100 * time.Millisecond {
		allocate(tiles, estimateOf(2e6, 2e6), 0, 0, at(step))
		if !state.paused {
			t.Fatalf("resumed after %v of fit, inside the 8 s backoff", step)
		}
	}
	allocate(tiles, estimateOf(2e6, 2e6), 0, 0, at(8*time.Second))
	if state.paused {
		t.Fatalf("state %+v after the backoff on a fitting estimate, want resumed", state)
	}
}

// Ten cameras that all hold h need 12 Mbit/s. When the estimate falls to 5, the
// early tiles must step down to l so the later ones keep flowing, rather than
// the later ones pausing for good behind tiles that never give room back.
func TestAnEstimateDipLowersEarlyTilesInsteadOfPausingLateOnes(t *testing.T) {
	states := make([]allocation, 10)
	tiles := make([]tile, len(states))
	for index := range states {
		states[index] = allocation{decided: true, rid: "h", backoff: backoffMin}
		tiles[index] = camera(&states[index])
		tiles[index].order = uint64(index)
	}
	for step := range 8 {
		allocate(tiles, estimateOf(5e6, 5e6), 0, 0, at(time.Duration(step)*500*time.Millisecond))
	}
	high := 0
	for index := range states {
		if states[index].paused {
			t.Fatalf("tile %d paused on a 5 Mbit/s estimate that carries ten tiles at l", index)
		}
		if states[index].rid == "h" {
			high++
		}
	}
	if high > 1 {
		t.Fatalf("%d tiles stayed on h, but 5 Mbit/s carries 3 Mbit/s of l plus one step up at most", high)
	}
}

// A paused tile gets its room back when the others hold more than their lowest
// layers, so a tile paused in a dip resumes once the estimate recovers.
func TestAPausedTileResumesBecauseTheOthersMakeRoom(t *testing.T) {
	states := make([]allocation, 4)
	tiles := make([]tile, len(states))
	for index := range states {
		states[index] = allocation{decided: true, rid: "h", backoff: backoffMin}
		tiles[index] = camera(&states[index])
		tiles[index].order = uint64(index)
	}
	states[3] = allocation{decided: true, paused: true, backoff: backoffMin}
	// Three tiles on h take 3.6 Mbit/s of a 4.5 Mbit/s estimate: the fourth's
	// 345 kbit/s fits only if one of them steps down.
	for step := range 12 {
		allocate(tiles, estimateOf(4.1e6, 4.1e6), 0, 0, at(time.Duration(step)*500*time.Millisecond))
	}
	if states[3].paused {
		t.Fatal("the paused tile never resumed while three others held h")
	}
}

// A paused tile that comes back before a playing one in priority order must still get its room
// from the playing tile's high layer.
func TestAPausedTileBeforeAPlayingOneResumes(t *testing.T) {
	paused := allocation{decided: true, paused: true, backoff: backoffMin}
	playing := allocation{decided: true, rid: "h", backoff: backoffMin}
	tiles := []tile{camera(&paused), camera(&playing)}
	tiles[0].order, tiles[1].order = 0, 1
	for step := range 20 {
		allocate(tiles, estimateOf(1.5e6, 1.5e6), 0, 0, at(time.Duration(step)*500*time.Millisecond))
	}
	if paused.paused {
		t.Fatal("the earlier paused tile never resumed while the later tile held h")
	}
}

func TestAStalledNodeNeitherDropsNorPausesATile(t *testing.T) {
	// The estimate fell to 100 kbit/s because the node stalled for 400 ms, so no layer fits.
	stalled := estimateOf(100_000, 100_000)
	stalled.pressured = true
	var state allocation
	tiles := []tile{camera(&state)}
	allocate(tiles, estimateOf(5e6, 5e6), 0, 0, at(0))
	allocate(tiles, estimateOf(5e6, 5e6), 0, 0, at(600*time.Millisecond))
	if state.rid != "h" {
		t.Fatalf("rid %q on a proven 5 Mbit/s path, want h", state.rid)
	}
	for tick := range 40 { // four seconds of a node that keeps the estimate low
		if probe := allocate(tiles, stalled, 0, 0, at(time.Second+time.Duration(tick)*100*time.Millisecond)); probe != 0 {
			t.Fatalf("asked for a probe of %.0f while the node was stalled", probe)
		}
	}
	if state.rid != "h" || state.paused {
		t.Fatalf("rid %q paused %v after a stall, want h and flowing", state.rid, state.paused)
	}
	// The same low estimate on a healthy node is real congestion and still drops the tile.
	allocate(tiles, estimateOf(100_000, 100_000), 0, 0, at(5*time.Second))
	if state.rid != "l" {
		t.Fatalf("rid %q on a real 100 kbit/s estimate, want l", state.rid)
	}
}

// A 650 kbit/s stream on a 600 kbit/s path, with the control loop freezing for
// 300 ms every 2.1 s, must still give up its high layer once the cap on pressure
// ends. Each freeze begins inside the hold of the one before, so a cap that
// restarted on every freeze would hold the layer for as long as the freezes last.
func TestRepeatedControlFreezesHoldAHighLayerNoLongerThanTheCap(t *testing.T) {
	link := &bottleneck{capacity: 600_000, queueBytes: 60_000, delay: int64(20 * time.Millisecond)}
	run := newSimulation(link)
	var node hostPressure
	var state allocation
	tiles := []tile{{layers: []layerRate{{rid: "h", bps: 650_000}, {rid: "l", bps: 300_000}}, state: &state}}
	allocate(tiles, estimateOf(5e6, 5e6), 0, 0, run.now)
	allocate(tiles, estimateOf(5e6, 5e6), 0, 0, run.now+int64(600*time.Millisecond))
	if state.rid != "h" {
		t.Fatalf("rid %q before the run, want h", state.rid)
	}
	sending := func(*simulation) float64 {
		if state.rid == "h" {
			return 650_000
		}
		return 300_000
	}
	start := run.now
	var dropped time.Duration
	for tick := time.Duration(0); tick < 40*time.Second && dropped == 0; tick += allocationInterval {
		frozen := tick >= 300*time.Millisecond && (tick-300*time.Millisecond)%(2100*time.Millisecond) < 300*time.Millisecond
		run.run(allocationInterval, sending, 0)
		if frozen {
			continue
		}
		node.controlTick(run.now)
		pressured := node.active(run.now)
		run.estimator.pressure(pressured)
		estimate := estimateOf(run.estimator.current(), run.estimator.proven(run.now))
		estimate.pressured = pressured
		allocate(tiles, estimate, 0, 0, run.now)
		if state.rid == "l" || state.paused {
			dropped = time.Duration(run.now - start)
		}
	}
	t.Logf("the high layer went after %v", dropped)
	if dropped == 0 {
		t.Fatalf("the high layer was still sent 40 s into repeating freezes on a path too small for it")
	}
	if limit := pressureMax + 2*time.Second; dropped > limit {
		t.Fatalf("the high layer went after %v, want within %v of the first freeze", dropped, limit)
	}
}
