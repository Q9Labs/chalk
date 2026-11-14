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
