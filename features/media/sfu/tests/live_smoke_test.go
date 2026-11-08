package tests

import (
	"bufio"
	"bytes"
	"cmp"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

const (
	liveTenant = "live-smoke"
	// liveChunk is the payload bytes per video packet, near a browser's MTU.
	liveChunk = 1100
	// liveScreenKbps is a detailed screen share; the SDK leaves its bitrate to the browser.
	liveScreenKbps = 1500
	// liveStall is the gap between frames, or between microphone packets, that a viewer sees as a freeze.
	liveStall = 500 * time.Millisecond
	// liveShareStartup is how long a share stretch may take to deliver its first frame to a viewer.
	liveShareStartup = 5 * time.Second
)

// liveLoad is the shape of a live run.
type liveLoad struct {
	classes, classOffset, participants, cameras int
	smallTiles                                  int    // classes larger than this ask for l, except one featured Participant's cameras
	cameraKbps                                  [2]int // h and l
	shareDuty                                   float64
	sharePeriod, hold, step, every              time.Duration
	samples                                     string
	capKbps                                     int           // caps the first Participant's downlink, 0 for none
	capAfter                                    time.Duration // after this long in the hold
	capEvery                                    time.Duration // lift and restore the cap at this interval, 0 to keep it
	capWithin                                   time.Duration // the capped Participant must back off within this long of each cap
}

// shareOn is how long one share stretch lasts.
func (l liveLoad) shareOn() time.Duration {
	return time.Duration(l.shareDuty * float64(l.sharePeriod))
}

func liveLoadFromEnv(t *testing.T) liveLoad {
	t.Helper()
	load := liveLoad{classes: 2, participants: 3, cameras: 2, cameraKbps: [2]int{2500, 650}, shareDuty: 0.65,
		sharePeriod: 4 * time.Minute, hold: 5 * time.Minute, every: time.Minute, capAfter: time.Minute, capWithin: 10 * time.Second, samples: os.Getenv("SFU_LIVE_SAMPLES")}
	settings := []struct {
		name   string
		target any
	}{
		{"SFU_LIVE_CLASSES", &load.classes}, {"SFU_LIVE_PARTICIPANTS", &load.participants}, {"SFU_LIVE_CAMERAS", &load.cameras},
		{"SFU_LIVE_CLASS_OFFSET", &load.classOffset},
		{"SFU_LIVE_SMALL_TILES", &load.smallTiles},
		{"SFU_LIVE_CAMERA_KBPS", &load.cameraKbps}, {"SFU_LIVE_SHARE_DUTY", &load.shareDuty}, {"SFU_LIVE_SHARE_PERIOD", &load.sharePeriod},
		{"SFU_LIVE_CAP_KBPS", &load.capKbps}, {"SFU_LIVE_CAP_AFTER", &load.capAfter}, {"SFU_LIVE_CAP_EVERY", &load.capEvery}, {"SFU_LIVE_CAP_WITHIN", &load.capWithin},
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
	// The subscriber is judged every two seconds, so the hold must outlast the
	// deadline by two polls or a run could end with no verdict.
	if need := load.capAfter + load.capWithin + 4*time.Second; load.capKbps > 0 && load.hold < need {
		t.Fatalf("SFU_LIVE_HOLD=%v ends before the capped Participant is judged; it needs at least SFU_LIVE_CAP_AFTER + SFU_LIVE_CAP_WITHIN + 4s = %v", load.hold, need)
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
	errCh := make(chan error, 1)
	go func() {
		defer close(done)
		encoder := json.NewEncoder(file)
		var previous runtime.MemStats
		runtime.ReadMemStats(&previous)
		expected := time.Now().Add(time.Second)
		for {
			timer := time.NewTimer(time.Until(expected))
			select {
			case <-ctx.Done():
				timer.Stop()
				return
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
				errCh <- err
				return
			}
			previous = current
			expected = expected.Add(time.Second)
			for !expected.After(actual) {
				expected = expected.Add(time.Second)
			}
		}
	}()

	return func() {
		cancel()
		<-done
		select {
		case err := <-errCh:
			t.Errorf("write generator diagnostics: %v", err)
		default:
		}
		if err := file.Close(); err != nil {
			t.Errorf("close generator diagnostics: %v", err)
		}
	}
}

// frameBytes is one frame's size at a bitrate and the fixtures' 30 frames/s.
func frameBytes(kbps int) int { return kbps * 1000 / 8 / 30 }

// TestLiveSmokeClasses holds classes on a deployed node and samples what the
// node and the peers saw. Each Participant publishes simulcast cameras at the
// browser SDK's layer caps and a microphone, the first Participant of each
// class shares a screen in stretches, and everyone pulls everyone. It runs
// only against a live node:
//
//	SFU_LIVE_URL           the node's control URL, such as an SSH tunnel
//	SFU_LIVE_CA            the service CA
//	SFU_LIVE_CERT, _KEY    a client certificate with the API identity
//	SFU_LIVE_CLASSES       classes to hold (default 2)
//	SFU_LIVE_CLASS_OFFSET  first class index for disjoint generator subsets (default 0)
//	SFU_LIVE_PARTICIPANTS  Participants per class (default 3)
//	SFU_LIVE_CAMERAS       cameras per Participant (default 2)
//	SFU_LIVE_SMALL_TILES   in a class of more Participants than this, every viewer asks for the
//	                       low layer of all cameras but the next Participant's, as the SDK does
//	                       for tiles of 400 px or less (default 0, which asks for the top layer)
//	SFU_LIVE_CAMERA_KBPS   the cameras' h and l bitrates (default 2500,650)
//	SFU_LIVE_SHARE_DUTY    the part of the time each class shares (default 0.65)
//	SFU_LIVE_SHARE_PERIOD  one share stretch and one pause (default 4m)
//	SFU_LIVE_CAP_KBPS      cap the first Participant's downlink at this rate, to see the node back off (default none)
//	SFU_LIVE_CAP_AFTER     how long into the hold the cap starts (default 1m)
//	SFU_LIVE_CAP_EVERY     lift the cap and restore it at this interval, to see the node back off again (default keep it)
//	SFU_LIVE_HOLD          how long to hold them (default 5m)
//	SFU_LIVE_STEP          add a class at this interval until the node refuses
//	                       one or a quality signal breaks (default off)
//	SFU_LIVE_SAMPLE        how often to sample (default 1m)
//	SFU_LIVE_SAMPLES       a file to append one JSON sample per line to
//	SFU_LIVE_DIAGNOSTICS   a file for per-second timer-lateness and GC-pause samples
func TestLiveSmokeClasses(t *testing.T) {
	controlURL := os.Getenv("SFU_LIVE_URL")
	if controlURL == "" {
		t.Skip("SFU_LIVE_URL is not set")
	}
	load := liveLoadFromEnv(t)
	t.Cleanup(startLiveGeneratorDiagnostics(t))
	var out *json.Encoder
	if load.samples != "" {
		file, err := os.OpenFile(load.samples, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = file.Close() })
		out = json.NewEncoder(file)
	}
	svc := &service{baseURL: controlURL, client: liveClient(t)}
	// The node keeps operation IDs for idempotency, so each run needs its own.
	operations.Store(time.Now().UnixNano())
	run := time.Now().UnixNano()
	sharing, stopSharing := context.WithCancel(context.Background())
	t.Cleanup(stopSharing)

	var mu sync.Mutex
	var classes []*liveClass
	classIndexes := make(map[*liveClass]int)
	join := func() string {
		index, joining := load.classOffset+len(classes), time.Now()
		defer func() {
			t.Logf("class %d joined at %s in %v", index, joining.UTC().Format(time.TimeOnly), time.Since(joining).Round(time.Millisecond))
		}()
		class, refused := joinClass(t, svc, load, run, index)
		if refused != "" {
			return refused
		}
		if load.shareOn() > 0 {
			class.shareStart.Store(time.Now().UnixNano())
		}
		var classCtx context.Context
		classCtx, class.stop = context.WithCancel(sharing)
		go class.shareInStretches(classCtx, load, time.Duration(index)*load.sharePeriod/5)
		mu.Lock()
		classes = append(classes, class)
		classIndexes[class] = index
		mu.Unlock()
		for deadline := time.Now().Add(30 * time.Second); !class.flowing(); time.Sleep(100 * time.Millisecond) {
			if time.Now().After(deadline) {
				// The retry starts a class of its own, so this one must not stay in the run.
				why := fmt.Sprintf("class %d: a Participant missed a microphone or screen for 30 s: %s", index, class.describe(svc))
				class.shutdown()
				mu.Lock()
				classes = without(classes, class)
				mu.Unlock()
				_, _ = svc.call(t, "/v1/episodes/end", protocol.EndEpisodeRequest{TenantID: liveTenant, EpisodeID: class.episode}, nil)
				return why
			}
		}
		return ""
	}
	// The API renews every standing grant every 5 s; without it a source's
	// 15-second lease lapses and the node stops forwarding it.
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-sharing.Done():
				return
			case <-ticker.C:
			}
			mu.Lock()
			live := classes
			mu.Unlock()
			for _, class := range live {
				class.renewGrants(svc)
			}
		}
	}()

	// The guard may close admission for a few seconds while classes join, so a
	// fixed run retries a refused class as a client would, and logs each refusal.
	for range load.classes {
		for attempt := 1; ; attempt++ {
			refused := join()
			if refused == "" {
				break
			}
			if attempt == 6 {
				t.Fatalf("the node refused class %d %d times: %s", load.classOffset+len(classes), attempt, refused)
			}
			t.Logf("refused, retrying in 10 s: %s", refused)
			time.Sleep(10 * time.Second)
		}
	}
	var capJudged atomic.Bool // the capped Participant has backed off or failed its deadline, and the last cap is judged
	if load.capKbps > 0 {
		go capFirstParticipant(sharing, t, svc, classes[0].people[0], load, &capJudged)
	}
	cpu := readHostCPU()
	// The baseline comes before the first wait, so drops during that wait count.
	mu.Lock()
	live := slices.Clone(classes)
	mu.Unlock()
	first := takeSample(svc, live, &cpu)
	first.Elapsed = "0s"
	previous := first
	started := time.Now()
	nextStep := started.Add(load.step)
	ticker := time.NewTicker(load.every)
	defer ticker.Stop()
	for time.Since(started) < load.hold {
		<-ticker.C
		mu.Lock()
		live := slices.Clone(classes)
		mu.Unlock()
		sample := takeSample(svc, live, &cpu)
		sample.Elapsed = time.Since(started).Round(time.Second).String()
		if load.step > 0 {
			sample.Broke = qualityBreak(previous, sample)
		}
		if load.step > 0 && sample.Broke == "" && !time.Now().Before(nextStep) {
			sample.Refused = join()
			nextStep = nextStep.Add(load.step)
		}
		if out != nil {
			if err := out.Encode(sample); err != nil {
				t.Fatal(err)
			}
		}
		t.Log(sample.line())
		previous = sample
		if sample.Broke != "" || sample.Refused != "" {
			t.Logf("step-up stopped at %d classes: %s%s", len(live), sample.Broke, sample.Refused)
			break
		}
	}
	mu.Lock()
	if load.capKbps > 0 {
		if !capJudged.Load() {
			t.Errorf("the run ended before the capped Participant backed off or failed its %v deadline", load.capWithin)
		}
		capped := classes[0].receivers[0]
		capped.mu.Lock()
		for key, track := range capped.tracks {
			if stalls, longest := track.stallsAt(time.Now(), classes[0].sharingSince()); track.kind == "audio" && stalls > 0 {
				t.Errorf("%s: the capped Participant's audio %s stalled %d times, longest %v", classes[0].people[0].name, key, stalls, longest)
			}
		}
		capped.mu.Unlock()
	}
	t.Logf("first class at the end:%s", classes[0].describe(svc))
	for _, class := range classes {
		for index, receiver := range class.receivers {
			receiver.mu.Lock()
			for key, track := range receiver.tracks {
				if stalls, longest := track.stallsAt(time.Now(), class.sharingSince()); stalls > 0 {
					t.Logf("class %d stalled: %s %s %s: %d stalls, longest %v ending %s, frames %v", classIndexes[class], class.people[index].name, key, track.kind, stalls, longest, track.longestAt.UTC().Format(time.RFC3339Nano), track.frames)
				}
			}
			receiver.mu.Unlock()
		}
	}
	mu.Unlock()
	if load.step > 0 {
		return
	}
	// A last sample at the end of the window, so a track that went quiet after the previous
	// one still counts.
	for _, failure := range fixedRunFailures(first, takeSample(svc, classes, &cpu)) {
		t.Error(failure)
	}
}

// capFirstParticipant squeezes one Participant's downlink after a while and
// logs, every two seconds, what the node thinks of it: the estimate and what
// its subscriptions forward. Each cap must bring the estimate under twice the
// cap and take every tile off the high layer within load.capWithin, or the run
// fails. The final report fails the run too if that Participant's audio stalled,
// or if the run ends before a cap has been judged.
func capFirstParticipant(ctx context.Context, t *testing.T, svc *service, person *participant, load liveLoad, judged *atomic.Bool) {
	started := time.Now()
	capped := 0 // cap changes so far: odd while the cap is on
	var cappedAt time.Duration
	var switchAt time.Duration
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if since := time.Since(started); since >= load.capAfter && (capped == 0 || load.capEvery > 0 && since >= switchAt) {
			capped++
			rate := float64(load.capKbps) * 1000
			if capped%2 == 1 {
				person.link.shape(rate, int(rate/8/5), 20*time.Millisecond, 0, 0)
				t.Logf("capped: %s downlink limited to %d kbit/s at %s", person.name, load.capKbps, time.Now().Format(time.TimeOnly))
				cappedAt = since
				judged.Store(false)
			} else {
				person.link.shape(0, 0, 0, 0, 0)
				if !judged.Load() {
					t.Errorf("%s was lifted from the %d kbit/s cap before it backed off", person.name, load.capKbps)
				}
				judged.Store(true)
				t.Logf("capped: %s downlink lifted at %s", person.name, time.Now().Format(time.TimeOnly))
			}
			switchAt = since + load.capEvery
		}
		var inspected protocol.InspectResponse
		if err := post(svc, "/v1/sessions/"+person.conn+"/inspect", protocol.InspectRequest{Scope: person.scope}, &inspected); err != nil {
			if capped%2 == 1 && !judged.Load() && time.Since(started)-cappedAt > load.capWithin {
				judged.Store(true)
				t.Errorf("%s could not be inspected for %v after the %d kbit/s cap: %v", person.name, load.capWithin, load.capKbps, err)
			}
			continue
		}
		forwarded := map[string]int{}
		for _, track := range inspected.Tracks {
			if sub := track.Subscription; sub != nil {
				forwarded[cmp.Or(sub.EffectiveRID, sub.State+"/"+sub.Reason)]++
			}
		}
		transport := inspected.Transport
		if capped%2 == 1 && !judged.Load() {
			since := time.Since(started) - cappedAt
			fell := forwarded["h"] == 0 && float64(transport.EstimateBps) <= 2*float64(load.capKbps)*1000
			switch {
			case since > load.capWithin:
				judged.Store(true)
				t.Errorf("%s did not back off within %v of the %d kbit/s cap (backed off by %v: %t): estimate %d, forwarding %v", person.name, load.capWithin, load.capKbps, since.Round(time.Second), fell, transport.EstimateBps, forwarded)
			case fell:
				judged.Store(true)
				t.Logf("capped: %s backed off %v after the cap: estimate %d, forwarding %v", person.name, since.Round(time.Second), transport.EstimateBps, forwarded)
			}
		}
		t.Logf("capped: +%v %s estimate %d proven %d queued %d dropped %d forwarding %v", time.Since(started).Round(time.Second), person.name, transport.EstimateBps, transport.ProvenBps, transport.QueuedBytes, transport.Dropped, forwarded)
	}
}

// fixedRunFailures judges a fixed-load run from its first and final samples. A sample
// without readiness data fails the run, and the peers' stalls are judged either way.
func fixedRunFailures(first, last liveSample) []string {
	var failures []string
	for _, missing := range []struct {
		name   string
		sample liveSample
	}{{"first", first}, {"final", last}} {
		if missing.sample.Ready == nil {
			failures = append(failures, fmt.Sprintf("the %s sample has no readiness data: %s", missing.name, cmp.Or(missing.sample.ReadyErr, "no sample was taken")))
		}
	}
	if first.Ready != nil && last.Ready != nil {
		if drops := receiveErrors(last) - receiveErrors(first); drops > 0 {
			failures = append(failures, fmt.Sprintf("the node dropped %d datagrams for a full receive buffer", drops))
		}
	}
	if stalls := last.Peers.AudioStalls; stalls > 0 {
		failures = append(failures, fmt.Sprintf("microphones stalled over %v %d times", liveStall, stalls))
	}
	if stalls := last.Peers.ScreenStalls; stalls > 0 {
		failures = append(failures, fmt.Sprintf("screen shares stalled or never reached a viewer %d times", stalls))
	}
	return failures
}

// without returns classes minus one. It copies, because the renewal loop and the samples
// iterate the old slice outside the lock and DeleteFunc would rewrite it under them.
func without(classes []*liveClass, gone *liveClass) []*liveClass {
	return slices.DeleteFunc(slices.Clone(classes), func(c *liveClass) bool { return c == gone })
}

// liveClass is one Episode of the run.
type liveClass struct {
	episode   string
	people    []*participant
	receivers []*liveReceiver
	// shareEpoch rises at every share start and stop, so a viewer can tell a
	// pause from a stall.
	shareEpoch atomic.Int64
	// shareStart is when the screen's current share stretch began, in Unix nanoseconds, or 0
	// while it is paused.
	shareStart atomic.Int64
	// stop ends the class's share goroutine.
	stop context.CancelFunc
}

// shutdown ends the class's share goroutine and closes its peers, so its publishers stop
// writing: a write on a closed peer fails and ends its loop.
func (c *liveClass) shutdown() {
	c.stop()
	for _, person := range c.people {
		_ = person.peer.pc.Close()
	}
}

// sharingSince is when the current share stretch began, or the zero time while the screen is paused.
func (c *liveClass) sharingSince() time.Time {
	if start := c.shareStart.Load(); start != 0 {
		return time.Unix(0, start)
	}
	return time.Time{}
}

// endStretch checks every viewer's screen at the end of a share stretch, so a viewer that
// got nothing or went quiet before the end shows a stall even though no later packet exposes it.
func (c *liveClass) endStretch(now time.Time) {
	since := c.sharingSince()
	for index, receiver := range c.receivers {
		if index == 0 {
			continue
		}
		receiver.mu.Lock()
		if screens := receiver.screens(); len(screens) == 0 {
			receiver.missedScreens++
		} else {
			for _, track := range screens {
				track.closeStretch(now, since)
			}
		}
		receiver.mu.Unlock()
	}
}

// joinClass joins one class and pulls everyone's media to everyone. It
// returns the node's refusal when admission turns a Participant away.
func joinClass(t *testing.T, svc *service, load liveLoad, run int64, index int) (*liveClass, string) {
	t.Helper()
	class := &liveClass{episode: fmt.Sprintf("live-smoke-%d-%d", run, index)}
	t.Cleanup(func() {
		_, _ = svc.call(t, "/v1/episodes/end", protocol.EndEpisodeRequest{TenantID: liveTenant, EpisodeID: class.episode}, nil)
	})
	what := publishing{cameras: load.cameras, chunks: [2]int{liveChunk, liveChunk}, screenChunk: liveChunk,
		frameBytes: [3]int{frameBytes(load.cameraKbps[0]), frameBytes(load.cameraKbps[1]), frameBytes(liveScreenKbps)}}
	for person := range load.participants {
		through := newLinkOn(t, "0.0.0.0:0")
		p := &participant{name: fmt.Sprintf("c%dp%d", index, person), link: through,
			scope: protocol.Scope{TenantID: liveTenant, EpisodeID: class.episode, ParticipantID: fmt.Sprintf("p%d", person), Generation: 1}}
		p.peer = newMediaPeer(t, through, true)
		receiver := receiveLive(p.peer, class)
		var created protocol.CreateSessionResponse
		if status, code := svc.call(t, "/v1/sessions", protocol.CreateSessionRequest{OperationID: op(), Scope: p.scope}, &created); status >= 300 {
			_, _ = svc.call(t, "/v1/episodes/end", protocol.EndEpisodeRequest{TenantID: liveTenant, EpisodeID: class.episode}, nil)
			var ready protocol.ReadyResponse
			_ = get(svc, "/readyz", &ready)
			return class, fmt.Sprintf("class %d Participant %d: %d %s (admission %q, steal %.1f%%, queue p95 %.1f ms)",
				index, person, status, code, ready.Host.AdmissionReason, *cmp.Or(ready.Host.StealPercent, new(float64)), ready.Host.QueueDelayP95Ms)
		}
		p.conn = created.ConnectionID
		svc.grantSources(t, p.scope)
		what.screen = person == 0
		p.publish(t, svc, what)
		class.people = append(class.people, p)
		class.receivers = append(class.receivers, receiver)
	}
	for index, person := range class.people {
		var tracks []protocol.Track
		featured := class.people[(index+1)%len(class.people)]
		for _, other := range class.people {
			if other == person {
				continue
			}
			tracks = append(tracks, remote(other, micName))
			small := load.smallTiles > 0 && load.participants > load.smallTiles && other != featured
			for camera := range load.cameras {
				track := remote(other, cameraTrack(camera))
				if small {
					track.Simulcast.PreferredRID = "l"
				}
				tracks = append(tracks, track)
			}
			if other.screen != nil {
				tracks = append(tracks, remote(other, screenName))
			}
		}
		for batch := range slices.Chunk(tracks, protocol.MaxTracksPerRequest) {
			person.pull(t, svc, batch)
		}
	}
	return class, ""
}

// shareInStretches turns the sharer's screen on and off so it is on for the
// duty share of every period, starting phase into its first stretch.
func (c *liveClass) shareInStretches(ctx context.Context, load liveLoad, phase time.Duration) {
	screen := c.people[0].screen
	on := load.shareOn()
	off := load.sharePeriod - on
	if on <= 0 {
		c.shareEpoch.Add(1)
		screen.enable(0, false)
		return
	}
	if off <= 0 {
		return
	}
	wait, live := on-phase%on, true
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		live = !live
		if !live {
			c.endStretch(time.Now())
			c.shareStart.Store(0)
		}
		c.shareEpoch.Add(1)
		screen.enable(0, live)
		wait = off
		if live {
			c.shareStart.Store(time.Now().UnixNano())
			wait = on
		}
	}
}

// flowing reports whether every Participant hears everyone else and, while the
// screen is shared, every other viewer sees it. Which cameras it sees is the
// allocator's call, so the samples report that.
func (c *liveClass) flowing() bool {
	sharing := !c.sharingSince().IsZero()
	for index, receiver := range c.receivers {
		if receiver.microphones() < len(c.people)-1 {
			return false
		}
		if sharing && index > 0 && !receiver.sawScreen() {
			return false
		}
	}
	return true
}

// describe lists what each Participant receives and how the node delivers it.
func (c *liveClass) describe(svc *service) string {
	var out strings.Builder
	for index, person := range c.people {
		receiver := c.receivers[index]
		receiver.mu.Lock()
		fmt.Fprintf(&out, "\n%s receives:", person.name)
		for key, track := range receiver.tracks {
			fmt.Fprintf(&out, " %s(%s layer %q frames %v unique %d)", key, track.kind, track.layer, track.frames, track.unique)
		}
		receiver.mu.Unlock()
		var inspected protocol.InspectResponse
		if err := post(svc, "/v1/sessions/"+person.conn+"/inspect", protocol.InspectRequest{Scope: person.scope}, &inspected); err != nil {
			fmt.Fprintf(&out, "; inspect: %v", err)
			continue
		}
		transport := inspected.Transport
		fmt.Fprintf(&out, "; transport estimate %d proven %d feedback age %v queued %d probing %v sent %+v dropped %d probes %d/%d; episode %+v",
			transport.EstimateBps, transport.ProvenBps, transport.FeedbackAgeMs, transport.QueuedBytes, transport.Probing, transport.Sent, transport.Dropped, transport.ProvedProbe, transport.Probes, inspected.Episode)
		for _, track := range inspected.Tracks {
			if track.Subscription != nil {
				fmt.Fprintf(&out, "; %s/%s %+v", track.SessionID, track.TrackName, *track.Subscription)
			}
		}
	}
	return out.String()
}

// renewGrants renews every Participant's sources in one request, as the API does.
func (c *liveClass) renewGrants(svc *service) {
	var controls []protocol.SourceControl
	for _, person := range c.people {
		for _, source := range []string{"microphone", "camera", "screen", "screen_audio"} {
			controls = append(controls, protocol.SourceControl{ParticipantID: person.scope.ParticipantID, Source: source, Action: protocol.SourceGrant, Revision: 1})
		}
	}
	_ = post(svc, "/v1/episodes/sources", protocol.SourceControlRequest{TenantID: liveTenant, EpisodeID: c.episode, Controls: controls}, nil)
}

// liveReceiver keeps one peer's per-track delivery statistics.
type liveReceiver struct {
	class  *liveClass
	mu     sync.Mutex
	tracks map[string]*liveTrack
	// missedScreens counts share stretches that ended with no screen track at this viewer.
	missedScreens int64
}

func receiveLive(p *peer, class *liveClass) *liveReceiver {
	r := &liveReceiver{class: class, tracks: map[string]*liveTrack{}}
	p.pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		stats := &liveTrack{kind: "audio", clock: float64(track.Codec().ClockRate), frames: map[string]int64{}}
		switch {
		case strings.HasPrefix(track.ID(), cameraName):
			stats.kind = "camera"
		case track.ID() == screenName:
			stats.kind = "screen"
		}
		r.mu.Lock()
		r.tracks[track.StreamID()+"/"+track.ID()] = stats
		r.mu.Unlock()
		go func() {
			for {
				packet, _, err := track.ReadRTP()
				if err != nil {
					return
				}
				at, epoch, since := time.Now(), r.class.shareEpoch.Load(), r.class.sharingSince()
				r.mu.Lock()
				stats.observe(packet, at, epoch, since)
				r.mu.Unlock()
			}
		}()
	})
	return r
}

// microphones counts the microphones that delivered audio.
func (r *liveReceiver) microphones() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	count := 0
	for _, track := range r.tracks {
		if track.kind == "audio" && track.frames["audio"] > 0 {
			count++
		}
	}
	return count
}

// screens lists the screen tracks received. The caller holds r.mu.
func (r *liveReceiver) screens() []*liveTrack {
	var found []*liveTrack
	for _, track := range r.tracks {
		if track.kind == "screen" {
			found = append(found, track)
		}
	}
	return found
}

// sawScreen reports whether a screen frame arrived.
func (r *liveReceiver) sawScreen() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, track := range r.tracks {
		if track.kind == "screen" && track.frames["screen"] > 0 {
			return true
		}
	}
	return false
}

// liveTrack is one received track: frames per layer, stalls, loss and jitter.
type liveTrack struct {
	kind  string // audio, camera or screen
	clock float64
	// layer is the latest keyframe's layer, told apart by the fixtures' widths.
	layer    string
	frames   map[string]int64 // video frames by layer; audio packets under "audio"
	switches int64
	stalls   int64
	longest  time.Duration
	// longestAt is when the longest stall ended.
	longestAt time.Time
	lastAt    time.Time // the latest frame start, or audio packet
	lastTS    uint32
	epoch     int64
	// Loss counts unique sequence numbers against the extended range; a share
	// pause starts a new range, because the sender's counters run on through it.
	started            bool
	first, highest     int64
	seen               [4096]int64 // extended sequence number + 1, by slot
	received, expected int64       // of closed ranges
	unique             int64       // in the open range
	// jitter is RFC 3550 interarrival jitter, in seconds.
	jitter  float64
	prevAt  time.Time
	prevTS  uint32
	hasPrev bool
}

func (s *liveTrack) observe(packet *rtp.Packet, at time.Time, epoch int64, since time.Time) {
	if s.kind == "screen" && epoch != s.epoch && s.started {
		s.closeRange()
	}
	if !s.sequence(packet.SequenceNumber) {
		return
	}
	if s.hasPrev {
		d := at.Sub(s.prevAt).Seconds() - float64(int32(packet.Timestamp-s.prevTS))/s.clock
		s.jitter += (math.Abs(d) - s.jitter) / 16
	}
	s.prevAt, s.prevTS, s.hasPrev = at, packet.Timestamp, true

	if s.kind == "audio" {
		s.gap(at, epoch, since)
		s.frames["audio"]++
		return
	}
	if s.lastAt.IsZero() || int32(packet.Timestamp-s.lastTS) > 0 {
		s.gap(at, epoch, since)
		s.lastTS = packet.Timestamp
	}
	var vp8 codecs.VP8Packet
	if data, err := vp8.Unmarshal(packet.Payload); err == nil && vp8.S == 1 && vp8.PID == 0 && len(data) >= 10 && data[0]&0x01 == 0 {
		layer := "l"
		if binary.LittleEndian.Uint16(data[6:8])&0x3FFF >= 320 {
			layer = "h"
		}
		if s.kind == "screen" {
			layer = "screen"
		}
		if s.layer != "" && layer != s.layer {
			s.switches++
		}
		s.layer = layer
	}
	if packet.Marker && s.layer != "" {
		s.frames[s.layer]++
	}
}

// gap counts a stall when media stopped for longer than liveStall while the
// source was meant to send. The first frame of a share stretch has liveShareStartup
// instead, counted when it arrives, so a late start stays in the count.
func (s *liveTrack) gap(at time.Time, epoch int64, since time.Time) {
	var quiet time.Duration
	switch {
	case s.kind == "screen" && !since.IsZero() && s.lastAt.Before(since):
		if delay := at.Sub(since); delay > liveShareStartup {
			quiet = delay
		}
	case !s.lastAt.IsZero() && epoch == s.epoch:
		if gap := at.Sub(s.lastAt); gap > liveStall {
			quiet = gap
		}
	}
	if quiet > 0 {
		s.stalls++
		if quiet > s.longest {
			s.longest, s.longestAt = quiet, at
		}
	}
	s.lastAt, s.epoch = at, epoch
}

// silence is how long the track has been quiet at now when that is a stall, or zero. A
// microphone or camera is meant to send from its first packet on. A screen is meant to send
// from since, the start of its share stretch, and not at all while since is zero.
func (s *liveTrack) silence(now, since time.Time) time.Duration {
	if s.kind != "screen" {
		since = time.Time{}
	} else if since.IsZero() {
		return 0
	}
	from, limit := s.lastAt, liveStall
	if from.Before(since) {
		from, limit = since, liveShareStartup
	}
	if from.IsZero() {
		return 0
	}
	if quiet := now.Sub(from); quiet > limit {
		return quiet
	}
	return 0
}

// stallsAt is the stalls so far plus the one in progress, which no packet has ended yet.
func (s *liveTrack) stallsAt(now, since time.Time) (stalls int64, longest time.Duration) {
	stalls, longest = s.stalls, s.longest
	if quiet := s.silence(now, since); quiet > 0 {
		stalls++
		longest = max(longest, quiet)
	}
	return stalls, longest
}

// closeStretch counts the end of a share stretch as a stall when the screen had gone quiet.
func (s *liveTrack) closeStretch(now, since time.Time) {
	if quiet := s.silence(now, since); quiet > 0 {
		s.stalls++
		if quiet > s.longest {
			s.longest, s.longestAt = quiet, now
		}
	}
}

// sequence records a sequence number and reports whether it is new.
func (s *liveTrack) sequence(seq uint16) bool {
	if !s.started {
		s.started, s.first, s.highest, s.unique = true, int64(seq), int64(seq), 0
		clear(s.seen[:])
	}
	extended := s.highest + int64(int16(seq-uint16(s.highest)))
	slot := extended & int64(len(s.seen)-1)
	if s.seen[slot] == extended+1 {
		return false
	}
	s.seen[slot] = extended + 1
	s.unique++
	s.highest = max(s.highest, extended)
	s.first = min(s.first, extended)
	return true
}

func (s *liveTrack) closeRange() {
	s.expected += s.highest - s.first + 1
	s.received += s.unique
	s.started = false
}

func (s *liveTrack) totals() (expected, received int64) {
	expected, received = s.expected, s.received
	if s.started {
		expected += s.highest - s.first + 1
		received += s.unique
	}
	return expected, received
}

// liveSample is one interval's view of the node, the peers and the generator.
// Counters are cumulative since the run started.
type liveSample struct {
	At        time.Time               `json:"at"`
	Elapsed   string                  `json:"elapsed"`
	Classes   int                     `json:"classes"`
	Ready     *protocol.ReadyResponse `json:"ready,omitempty"`
	ReadyErr  string                  `json:"readyError,omitempty"`
	Node      nodeTotals              `json:"node"`
	Peers     peerTotals              `json:"peers"`
	Generator hostSample              `json:"generator"`
	Broke     string                  `json:"broke,omitempty"`
	Refused   string                  `json:"refused,omitempty"`
}

// nodeTotals sums what the node's inspect reports over every session.
type nodeTotals struct {
	Sessions      int `json:"sessions"`
	InspectErrors int `json:"inspectErrors"`
	// PacerDropped is video the pacer dropped on a full queue, RepairsCut
	// retransmissions over the repair cap, RepairSent the RTX it sent.
	PacerDropped uint64 `json:"pacerDropped"`
	RepairsCut   uint64 `json:"repairsCut"`
	RepairSent   uint64 `json:"repairSent"`
	VideoSent    uint64 `json:"videoSent"`
	AudioSent    uint64 `json:"audioSent"`
	Probes       uint64 `json:"probes"`
	// NacksToPublishers counts lost packets the node asked publishers to
	// resend, and RepairedFromPublishers the resends that arrived.
	NacksToPublishers      uint64         `json:"nacksToPublishers"`
	RepairedFromPublishers uint64         `json:"repairedFromPublishers"`
	QueuedBytes            int            `json:"queuedBytes"`
	Paused                 map[string]int `json:"paused"`    // subscriptions by pause reason
	Forwarded              map[string]int `json:"forwarded"` // camera subscriptions by forwarded layer
}

// peerTotals sums every receiving peer.
type peerTotals struct {
	Frames           map[string]int64 `json:"frames"` // h, l and screen frames, audio packets
	Switches         int64            `json:"layerSwitches"`
	VideoStalls      int64            `json:"videoStalls"` // cameras, which may adapt
	ScreenStalls     int64            `json:"screenStalls"`
	AudioStalls      int64            `json:"audioStalls"`
	LongestStallMs   int64            `json:"longestStallMs"`
	Expected         int64            `json:"expected"`
	Received         int64            `json:"received"`
	AudioJitterMs    float64          `json:"audioJitterMs"` // mean over tracks
	MaxAudioJitterMs float64          `json:"maxAudioJitterMs"`
	VideoJitterMs    float64          `json:"videoJitterMs"`
}

func takeSample(svc *service, classes []*liveClass, cpu *hostCPU) liveSample {
	now := time.Now()
	sample := liveSample{At: now.UTC(), Classes: len(classes)}
	var ready protocol.ReadyResponse
	if err := get(svc, "/readyz", &ready); err != nil {
		sample.ReadyErr = err.Error()
	} else {
		sample.Ready = &ready
	}
	node := nodeTotals{Paused: map[string]int{}, Forwarded: map[string]int{}}
	peers := peerTotals{Frames: map[string]int64{}}
	var audioTracks, videoTracks int
	for _, class := range classes {
		for index, person := range class.people {
			var inspected protocol.InspectResponse
			if err := post(svc, "/v1/sessions/"+person.conn+"/inspect", protocol.InspectRequest{Scope: person.scope}, &inspected); err != nil {
				node.InspectErrors++
			} else {
				node.add(inspected)
			}
			receiver := class.receivers[index]
			since := class.sharingSince()
			receiver.mu.Lock()
			if index > 0 {
				// Every viewer is meant to have a screen track in each share stretch.
				peers.ScreenStalls += receiver.missedScreens
				if len(receiver.screens()) == 0 && !since.IsZero() && now.Sub(since) > liveShareStartup {
					peers.ScreenStalls++
					peers.LongestStallMs = max(peers.LongestStallMs, now.Sub(since).Milliseconds())
				}
			}
			for _, track := range receiver.tracks {
				stalls, longest := track.stallsAt(now, since)
				for layer, frames := range track.frames {
					peers.Frames[layer] += frames
				}
				peers.Switches += track.switches
				if track.kind == "audio" {
					peers.AudioStalls += stalls
					peers.AudioJitterMs += track.jitter * 1000
					peers.MaxAudioJitterMs = max(peers.MaxAudioJitterMs, track.jitter*1000)
					audioTracks++
				} else {
					if track.kind == "screen" {
						peers.ScreenStalls += stalls
					} else {
						peers.VideoStalls += stalls
					}
					peers.VideoJitterMs += track.jitter * 1000
					videoTracks++
				}
				peers.LongestStallMs = max(peers.LongestStallMs, longest.Milliseconds())
				expected, received := track.totals()
				peers.Expected += expected
				peers.Received += received
			}
			receiver.mu.Unlock()
		}
	}
	if audioTracks > 0 {
		peers.AudioJitterMs /= float64(audioTracks)
	}
	if videoTracks > 0 {
		peers.VideoJitterMs /= float64(videoTracks)
	}
	sample.Node, sample.Peers = node, peers
	sample.Generator = cpu.sample()
	return sample
}

func (n *nodeTotals) add(inspected protocol.InspectResponse) {
	n.Sessions++
	transport := inspected.Transport
	n.PacerDropped += transport.Dropped
	n.RepairsCut += transport.RepairsCut
	n.RepairSent += transport.Sent.Repair
	n.VideoSent += transport.Sent.Video
	n.AudioSent += transport.Sent.Audio
	n.Probes += transport.Probes
	n.QueuedBytes += transport.QueuedBytes
	for _, track := range inspected.Tracks {
		for _, layer := range track.Layers {
			n.NacksToPublishers += layer.RequestedPackets
			n.RepairedFromPublishers += layer.RepairedPackets
		}
		subscription := track.Subscription
		if subscription == nil {
			continue
		}
		if subscription.State == protocol.SubscriptionPaused {
			n.Paused[subscription.Reason]++
		} else if strings.HasPrefix(track.TrackName, cameraName) {
			n.Forwarded[cmp.Or(subscription.EffectiveRID, "none")]++
		}
	}
}

// qualityBreak names the first signal past the step-up's limits: the pacer
// queue p95 over 20 ms, steal over 25%, closed admission, receive-buffer
// drops, pacer drops or a new microphone or screen stall since the previous sample. A
// camera stall is not a break, because the allocator may lower a camera.
func qualityBreak(previous, sample liveSample) string {
	ready := sample.Ready
	if ready == nil {
		return "readyz failed: " + sample.ReadyErr
	}
	switch {
	case ready.Host.QueueDelayP95Ms > 20:
		return fmt.Sprintf("pacer queue p95 %.1f ms", ready.Host.QueueDelayP95Ms)
	case ready.Host.StealPercent != nil && *ready.Host.StealPercent > 25:
		return fmt.Sprintf("steal %.1f%%", *ready.Host.StealPercent)
	case ready.Host.AdmissionReason != "":
		return "admission closed: " + ready.Host.AdmissionReason
	case previous.Ready != nil && receiveErrors(sample) > receiveErrors(previous):
		return fmt.Sprintf("%d receive-buffer drops", receiveErrors(sample)-receiveErrors(previous))
	case sample.Node.PacerDropped > previous.Node.PacerDropped:
		return fmt.Sprintf("%d pacer drops", sample.Node.PacerDropped-previous.Node.PacerDropped)
	case sample.Peers.AudioStalls > previous.Peers.AudioStalls:
		return fmt.Sprintf("%d microphone stalls", sample.Peers.AudioStalls-previous.Peers.AudioStalls)
	case sample.Peers.ScreenStalls > previous.Peers.ScreenStalls:
		return fmt.Sprintf("%d screen stalls", sample.Peers.ScreenStalls-previous.Peers.ScreenStalls)
	}
	return ""
}

func receiveErrors(sample liveSample) int64 {
	if sample.Ready == nil || sample.Ready.Host.UDPReceiveBufferErrors == nil {
		return 0
	}
	return int64(*sample.Ready.Host.UDPReceiveBufferErrors)
}

func (s liveSample) line() string {
	if s.Ready == nil {
		return fmt.Sprintf("%s classes %d: readyz failed: %s", s.Elapsed, s.Classes, s.ReadyErr)
	}
	steal := -1.0
	if s.Ready.Host.StealPercent != nil {
		steal = *s.Ready.Host.StealPercent
	}
	loss := 0.0
	if s.Peers.Expected > 0 {
		loss = 100 * float64(s.Peers.Expected-s.Peers.Received) / float64(s.Peers.Expected)
	}
	return fmt.Sprintf("%s classes %d sessions %d: %.0f pps, pacer p95 %.1f ms, steal %.1f%%, reserved %d/%d, admission %q; pacer drops %d, rcvbuf %d; peers h %d l %d screen %d, switches %d, stalls camera %d screen %d audio %d (longest %d ms), loss %.3f%%; generator cpu %.0f%%",
		s.Elapsed, s.Classes, s.Ready.Sessions, s.Ready.Host.PacketsPerSecond, s.Ready.Host.QueueDelayP95Ms, steal, s.Ready.ReservedPackets, s.Ready.PacketBudget, s.Ready.Host.AdmissionReason,
		s.Node.PacerDropped, receiveErrors(s), s.Peers.Frames["h"], s.Peers.Frames["l"], s.Peers.Frames["screen"], s.Peers.Switches, s.Peers.VideoStalls, s.Peers.ScreenStalls, s.Peers.AudioStalls, s.Peers.LongestStallMs, loss, s.Generator.CPUPercent)
}

// hostSample is the generator host's own load, so a run can show the
// generator was not the bottleneck. It is empty where /proc is absent.
type hostSample struct {
	CPUPercent      float64 `json:"cpuPercent"`
	StealPercent    float64 `json:"stealPercent"`
	UDPRcvbufErrors uint64  `json:"udpRcvbufErrors"`
}

type hostCPU struct{ total, idle, steal uint64 }

func readHostCPU() hostCPU {
	file, err := os.Open("/proc/stat")
	if err != nil {
		return hostCPU{}
	}
	defer file.Close()
	line, _ := bufio.NewReader(file).ReadString('\n')
	var cpu hostCPU
	for index, field := range strings.Fields(line)[1:] {
		var value uint64
		_, _ = fmt.Sscan(field, &value)
		cpu.total += value
		switch index {
		case 3, 4: // idle, iowait
			cpu.idle += value
		case 7:
			cpu.steal = value
		}
	}
	return cpu
}

func (c *hostCPU) sample() hostSample {
	next := readHostCPU()
	var sample hostSample
	if total := float64(next.total - c.total); total > 0 {
		sample.CPUPercent = 100 * (total - float64(next.idle-c.idle)) / total
		sample.StealPercent = 100 * float64(next.steal-c.steal) / total
	}
	*c = next
	if raw, err := os.ReadFile("/proc/net/snmp"); err == nil {
		var header []string
		for line := range strings.Lines(string(raw)) {
			fields := strings.Fields(line)
			if len(fields) == 0 || fields[0] != "Udp:" {
				continue
			}
			if header == nil {
				header = fields
				continue
			}
			for index, name := range header {
				if name == "RcvbufErrors" && index < len(fields) {
					_, _ = fmt.Sscan(fields[index], &sample.UDPRcvbufErrors)
				}
			}
		}
	}
	return sample
}

// post and get call the node without failing the test, so one slow sample
// does not end an hour-long run.
func post(svc *service, path string, body, out any) error {
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	response, err := svc.client.Post(svc.baseURL+path, "application/json", bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return fmt.Errorf("POST %s: %s", path, response.Status)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(response.Body).Decode(out)
}

func get(svc *service, path string, out any) error {
	response, err := svc.client.Get(svc.baseURL + path)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return fmt.Errorf("GET %s: %s", path, response.Status)
	}
	return json.NewDecoder(response.Body).Decode(out)
}

func liveClient(t *testing.T) *http.Client {
	t.Helper()
	pem, err := os.ReadFile(os.Getenv("SFU_LIVE_CA"))
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(pem)
	pair, err := tls.LoadX509KeyPair(os.Getenv("SFU_LIVE_CERT"), os.Getenv("SFU_LIVE_KEY"))
	if err != nil {
		t.Fatal(err)
	}
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: pool, ServerName: "chalk-sfu", Certificates: []tls.Certificate{pair}}}
	t.Cleanup(transport.CloseIdleConnections)
	return &http.Client{Transport: transport, Timeout: 20 * time.Second}
}
