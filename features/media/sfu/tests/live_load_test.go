package tests

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"testing"
	"time"
)

// liveLoad is the shape of a live run.
type liveLoad struct {
	classes, classOffset, participants, cameras int
	smallTiles                                  int    // classes larger than this ask for l, except one featured Participant's cameras
	cameraKbps                                  [2]int // h and l
	shareDuty                                   float64
	sharePeriod, hold, step, every              time.Duration
	samples                                     string
	result, nodeCPU                             string // the result file to write, and the node's 10 s CPU capture to read
	expectBudget                                int    // the packet budget the node must report, 0 for any
	short                                       bool
}

// shareOn is how long one share stretch lasts.
func (l liveLoad) shareOn() time.Duration {
	return time.Duration(l.shareDuty * float64(l.sharePeriod))
}

func liveLoadFromEnv(t *testing.T) liveLoad {
	t.Helper()
	// The defaults are the staging soak in docs/sfu/capacity-calibration.md: three classes of three
	// Participants with two cameras each, held for five hours, sampled every ten seconds.
	load := liveLoad{classes: 3, participants: 3, cameras: 2, cameraKbps: [2]int{2500, 650}, shareDuty: 0.65,
		sharePeriod: 4 * time.Minute, hold: soakHold, every: 10 * time.Second, expectBudget: stagingBudget,
		samples: os.Getenv("SFU_LIVE_SAMPLES"), result: os.Getenv("SFU_LIVE_RESULT"), nodeCPU: os.Getenv("SFU_LIVE_NODE_CPU")}
	if os.Getenv("SFU_LIVE_SHORT") != "" {
		load.short, load.hold = true, shortHold
	}
	settings := []struct {
		name   string
		target any
	}{
		{"SFU_LIVE_CLASSES", &load.classes}, {"SFU_LIVE_PARTICIPANTS", &load.participants}, {"SFU_LIVE_CAMERAS", &load.cameras},
		{"SFU_LIVE_CLASS_OFFSET", &load.classOffset},
		{"SFU_LIVE_SMALL_TILES", &load.smallTiles},
		{"SFU_LIVE_CAMERA_KBPS", &load.cameraKbps}, {"SFU_LIVE_SHARE_DUTY", &load.shareDuty}, {"SFU_LIVE_SHARE_PERIOD", &load.sharePeriod},
		{"SFU_LIVE_EXPECT_BUDGET", &load.expectBudget},
		{"SFU_LIVE_HOLD", &load.hold}, {"SFU_LIVE_STEP", &load.step}, {"SFU_LIVE_SAMPLE", &load.every},
	}
	for _, setting := range settings {
		value := os.Getenv(setting.name)
		if value == "" {
			continue
		}
		var err error
		switch target := setting.target.(type) {
		case *int:
			_, err = fmt.Sscan(value, target)
		case *float64:
			_, err = fmt.Sscan(value, target)
		case *time.Duration:
			*target, err = time.ParseDuration(value)
		case *[2]int:
			_, err = fmt.Sscanf(value, "%d,%d", &target[0], &target[1])
		}
		if err != nil {
			t.Fatalf("%s=%q: %v", setting.name, value, err)
		}
	}
	return load
}

type liveGeneratorDiagnostic struct {
	At             time.Time `json:"at"`
	Expected       time.Time `json:"expected"`
	WindowStart    time.Time `json:"windowStart"`
	LatenessNs     int64     `json:"latenessNs"`
	MaxLatenessNs  int64     `json:"maxLatenessNs"`
	MissedTicks    int64     `json:"missedTicks"`
	GCPauseDeltaNs uint64    `json:"gcPauseDeltaNs"`
	GCPauseTotalNs uint64    `json:"gcPauseTotalNs"`
}

// startLiveGeneratorDiagnostics records one timer-lateness and GC sample per
// expected second. A delayed wake is recorded once with its full lateness and
// missed tick count, then sampling resumes on the next future tick.
func startLiveGeneratorDiagnostics(t *testing.T) func() {
	t.Helper()
	path := os.Getenv("SFU_LIVE_DIAGNOSTICS")
	if path == "" {
		return func() {}
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	errCh := make(chan error, 1) // the sampler's result, sent before done closes
	go func() {
		defer close(done)
		errCh <- sampleGeneratorEverySecond(ctx, json.NewEncoder(file))
	}()

	return func() {
		cancel()
		<-done
		if err := <-errCh; err != nil {
			t.Errorf("write generator diagnostics: %v", err)
		}
		if err := file.Close(); err != nil {
			t.Errorf("close generator diagnostics: %v", err)
		}
	}
}

// sampleGeneratorEverySecond writes one diagnostic per expected second until ctx ends or a
// write fails. It returns the write error.
func sampleGeneratorEverySecond(ctx context.Context, encoder *json.Encoder) error {
	var previous runtime.MemStats
	runtime.ReadMemStats(&previous)
	expected := time.Now().Add(time.Second)
	for {
		timer := time.NewTimer(time.Until(expected))
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
		actual := time.Now()
		lateness := actual.Sub(expected).Nanoseconds()
		var current runtime.MemStats
		runtime.ReadMemStats(&current)
		missed := int64(0)
		if lateness > 0 {
			missed = lateness / int64(time.Second)
		}
		if err := encoder.Encode(liveGeneratorDiagnostic{
			At: actual.UTC(), Expected: expected.UTC(), WindowStart: expected.Truncate(time.Second).UTC(),
			LatenessNs: lateness, MaxLatenessNs: max(lateness, int64(0)), MissedTicks: missed,
			GCPauseDeltaNs: current.PauseTotalNs - previous.PauseTotalNs, GCPauseTotalNs: current.PauseTotalNs,
		}); err != nil {
			return err
		}
		previous = current
		expected = expected.Add(time.Second)
		for !expected.After(actual) {
			expected = expected.Add(time.Second)
		}
	}
}

// frameBytes is one frame's size at a bitrate and the fixtures' 30 frames/s.
func frameBytes(kbps int) int { return kbps * 1000 / 8 / 30 }
