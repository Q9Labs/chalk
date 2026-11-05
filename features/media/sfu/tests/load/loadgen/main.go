// Command loadgen drives an SFU with real Pion peers. Each Participant pushes a
// synthetic camera (high and low simulcast layers) and microphone and pulls every
// other Participant's camera and microphone, as in a real call. It talks to the SFU
// through the real mutual-TLS control API and counts what each subscriber receives.
//
// Load rises in steps: step k holds k Episodes of -size Participants. Each step is
// measured over a -hold window after a settle period, and the result of every step is
// written to -out as soon as it ends.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

type config struct {
	sfu, serverName, caFile, certFile, keyFile string
	iface                                      string
	loopback                                   bool
	size                                       int
	steps                                      []int
	hold, settle                               time.Duration
	joinParallel                               int
	stopLoss                                   float64
	out, label, stopFile                       string
	work                                       workload
}

type generator struct {
	cfg     config
	log     *slog.Logger
	control *controlClient
	api     *webrtc.API
	host    *hostRecorder

	mu           sync.Mutex
	participants []*participant
	episodes     [][]*participant
}

func main() {
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	cfg, err := parseFlags()
	if err != nil {
		log.Error("bad flags", "error", err)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, cfg, log); err != nil {
		log.Error("loadgen stopped", "error", err)
		os.Exit(1)
	}
}

func parseFlags() (config, error) {
	var cfg config
	var steps string
	var videoKbps, lowKbps int
	flag.StringVar(&cfg.sfu, "sfu", "", "SFU control base URL, e.g. https://203.0.113.10:8443")
	flag.StringVar(&cfg.serverName, "server-name", "sfu.bench.test", "TLS server name of the SFU certificate")
	flag.StringVar(&cfg.caFile, "ca", "ca.pem", "CA that signed the SFU certificate")
	flag.StringVar(&cfg.certFile, "cert", "client.pem", "client certificate")
	flag.StringVar(&cfg.keyFile, "key", "client.key", "client key")
	flag.StringVar(&cfg.iface, "iface", "", "only gather ICE candidates on this interface (e.g. eth0)")
	flag.BoolVar(&cfg.loopback, "loopback", false, "include loopback ICE candidates (local runs)")
	flag.IntVar(&cfg.size, "size", 4, "Participants per Episode")
	flag.StringVar(&steps, "steps", "1,2,4,8", "cumulative Episode counts, one measured step each")
	flag.DurationVar(&cfg.hold, "hold", 3*time.Minute, "measured window per step")
	flag.DurationVar(&cfg.settle, "settle", 15*time.Second, "wait after joining, before the window starts")
	flag.IntVar(&cfg.joinParallel, "join-parallel", 8, "Participants joining at once")
	flag.Float64Var(&cfg.stopLoss, "stop-loss", 5, "stop the ramp after a step whose loss percentage exceeds this")
	flag.StringVar(&cfg.out, "out", "steps.json", "results file")
	flag.StringVar(&cfg.stopFile, "stop-file", "", "stop the ramp after the current step once this file exists")
	flag.StringVar(&cfg.label, "label", "", "free-text label stored in the results")
	flag.IntVar(&videoKbps, "video-kbps", 2500, "camera high layer bitrate")
	flag.IntVar(&lowKbps, "low-kbps", 650, "camera low layer bitrate")
	flag.IntVar(&cfg.work.videoBytes, "video-payload", 1100, "video RTP payload bytes")
	flag.IntVar(&cfg.work.audioBytes, "audio-payload", 80, "audio RTP payload bytes")
	flag.Float64Var(&cfg.work.audioPPS, "audio-pps", 50, "audio packets per second")
	flag.BoolVar(&cfg.work.publishLow, "publish-low", true, "also publish the low simulcast layer")
	flag.DurationVar(&cfg.work.lowLag, "low-lag", time.Second, "how long after the high layer the low layer starts")
	flag.Parse()

	cfg.work.videoBitrate, cfg.work.lowBitrate = float64(videoKbps)*1000, float64(lowKbps)*1000
	if cfg.sfu == "" {
		return cfg, fmt.Errorf("-sfu is required")
	}
	if cfg.size < 2 || cfg.size > 9 {
		return cfg, fmt.Errorf("-size must be 2 to 9 (a pull is limited to %d tracks)", protocol.MaxTracksPerRequest)
	}
	for _, field := range strings.Split(steps, ",") {
		count, err := strconv.Atoi(strings.TrimSpace(field))
		if err != nil || count < 1 {
			return cfg, fmt.Errorf("bad step %q in -steps", field)
		}
		cfg.steps = append(cfg.steps, count)
	}
	if !sort.IntsAreSorted(cfg.steps) {
		return cfg, fmt.Errorf("-steps must not decrease")
	}
	return cfg, nil
}

func run(ctx context.Context, cfg config, log *slog.Logger) error {
	control, err := newControlClient(cfg.sfu, cfg.serverName, cfg.caFile, cfg.certFile, cfg.keyFile)
	if err != nil {
		return err
	}
	defer control.closeIdle()
	api, err := newAPI(cfg.iface, cfg.loopback)
	if err != nil {
		return err
	}
	g := &generator{cfg: cfg, log: log, control: control, api: api, host: newHostRecorder(cfg.iface)}
	go g.host.run(ctx)
	defer g.closeAll()

	var results []stepResult
	for _, episodes := range cfg.steps {
		result, err := g.step(ctx, episodes)
		results = append(results, result)
		if writeErr := writeResults(cfg.out, cfg, results); writeErr != nil {
			return writeErr
		}
		if err != nil {
			return fmt.Errorf("step %d Episodes: %w", episodes, err)
		}
		if _, err := os.Stat(cfg.stopFile); cfg.stopFile != "" && err == nil {
			log.Warn("stopping the ramp: stop file exists", "file", cfg.stopFile)
			break
		}
		if result.LossPct > cfg.stopLoss || result.DroppedDuringWindow > 0 {
			log.Warn("stopping the ramp", "lossPct", result.LossPct, "dropped", result.DroppedDuringWindow)
			break
		}
	}
	return nil
}

func writeResults(path string, cfg config, results []stepResult) error {
	file := resultsFile{Label: cfg.label, EpisodeSize: cfg.size, Workload: describe(cfg.work), Steps: results}
	encoded, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, encoded, 0o600)
}

// step grows the load to the given number of Episodes, then measures a window.
func (g *generator) step(ctx context.Context, episodes int) (stepResult, error) {
	started := time.Now()
	result := stepResult{Episodes: episodes, EpisodeSize: g.cfg.size}
	for len(g.episodes) < episodes {
		if err := g.addEpisode(ctx, len(g.episodes)); err != nil {
			return result, err
		}
	}
	g.log.Info("joined", "episodes", episodes, "participants", len(g.participants), "took", time.Since(started).Round(time.Second))

	select {
	case <-time.After(g.cfg.settle):
	case <-ctx.Done():
		return result, ctx.Err()
	}
	return g.measure(ctx, result)
}

// addEpisode joins one Episode's Participants, has each pull the others, and waits
// until every subscriber receives every stream.
func (g *generator) addEpisode(ctx context.Context, index int) error {
	people := make([]*participant, g.cfg.size)
	errs := make([]error, g.cfg.size)
	slots := make(chan struct{}, g.cfg.joinParallel)
	var wg sync.WaitGroup
	for i := range people {
		wg.Go(func() {
			slots <- struct{}{}
			defer func() { <-slots }()
			scope := protocol.Scope{TenantID: "bench", EpisodeID: fmt.Sprintf("ep-%03d", index), ParticipantID: fmt.Sprintf("p%d", i), Generation: 1}
			people[i], errs[i] = g.join(ctx, scope)
		})
	}
	wg.Wait()
	g.mu.Lock()
	for _, p := range people {
		if p != nil {
			g.participants = append(g.participants, p)
		}
	}
	g.mu.Unlock()
	for _, err := range errs {
		if err != nil {
			return fmt.Errorf("join Episode %d: %w", index, err)
		}
	}
	g.mu.Lock()
	g.episodes = append(g.episodes, people)
	g.mu.Unlock()

	for _, p := range people {
		select {
		case <-p.connected:
		case <-time.After(60 * time.Second):
			return fmt.Errorf("Episode %d: %s never connected", index, p.scope.ParticipantID)
		case <-ctx.Done():
			return ctx.Err()
		}
		p.startSending(ctx)
	}
	for i := range people {
		wg.Go(func() {
			others := make([]*participant, 0, len(people)-1)
			for j, other := range people {
				if j != i {
					others = append(others, other)
				}
			}
			errs[i] = g.pull(ctx, people[i], others)
		})
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return fmt.Errorf("pull in Episode %d: %w", index, err)
		}
	}
	return g.waitForStreams(ctx, people)
}

func (g *generator) waitForStreams(ctx context.Context, people []*participant) error {
	want := 2 * (len(people) - 1)
	deadline := time.Now().Add(60 * time.Second)
	for {
		ready := true
		for _, p := range people {
			streams := p.received.all()
			if len(streams) < want {
				ready = false
				break
			}
			for _, s := range streams {
				if !s.snapshot().started {
					ready = false
				}
			}
		}
		if ready {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("subscribers did not receive all %d streams within 60s", want)
		}
		select {
		case <-time.After(250 * time.Millisecond):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (g *generator) closeAll() {
	g.mu.Lock()
	all := append([]*participant(nil), g.participants...)
	g.mu.Unlock()
	var wg sync.WaitGroup
	for _, p := range all {
		wg.Go(p.closePeer)
	}
	wg.Wait()
}

// describe records the workload in the results so a run is self-explanatory.
func describe(w workload) workloadDescription {
	return workloadDescription{
		VideoKbps: w.videoBitrate / 1000, LowKbps: w.lowBitrate / 1000, VideoPayloadBytes: w.videoBytes,
		VideoPPS: ppsFor(w.videoBitrate, w.videoBytes), LowPPS: ppsFor(w.lowBitrate, w.videoBytes),
		AudioPayloadBytes: w.audioBytes, AudioPPS: w.audioPPS, PublishLow: w.publishLow,
	}
}
