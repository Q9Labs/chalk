package chalksfu

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

const (
	probeInterval = 2 * time.Second
	probeTimeout  = time.Second
	// A probe older than this no longer counts, so a node that stops answering
	// leaves placement within a few intervals.
	probeFreshness = 3 * probeInterval
	// An Episode this process placed on a node counts against that node's room for
	// this long. The SFU reserves packets only at the Episode's first join, so a probe
	// taken before the join does not show it. The counter is a burst guard: the SFU's
	// admission at first join stays the authority.
	inflightTTL = 30 * time.Second
)

// ErrUnknownNode means an Episode's binding names a node this process does not
// configure. The Episode is never moved to another node: its sessions live there.
var ErrUnknownNode = errors.New("chalk sfu node is not configured")

// Fleet is the SFU pool: every configured node in configuration order. A new
// Episode is placed on one node and its binding records it, so every later call
// for that Episode, cleanup included, goes to that node.
type Fleet struct {
	applicationID string
	overflow      bool
	nodes         []*Adapter
	standbys      map[string]bool // node IDs with the standby role
	standbyBudget int             // packets/s a standby admits for new Episodes
	log           *slog.Logger

	mu          sync.Mutex
	loads       map[string]nodeLoad
	seen        map[string]sighting    // when each node last answered a probe; a failed probe leaves it alone
	inflight    map[string][]time.Time // when this process placed each recent Episode, by node; a probe leaves it alone
	probed      bool                   // a probe round has finished, so a node without a load record has none
	firstRound  time.Time              // when the first probe round finished
	holdSeconds int                    // how long a recovery's reservation waits for rejoins; zero means recoveryHoldSeconds
}

// sighting is a node's last answered probe. Unlike its load record, which a failed probe
// deletes so placement skips the node, it survives a failed probe, so one lost probe does not
// make a live node look lost.
type sighting struct {
	at          time.Time
	incarnation string
}

// nodeLoad is a node's last answered probe. A silent node has none. A draining node has one with
// Draining set, so placement skips it, and is told apart from a silent node.
type nodeLoad struct {
	room        int  // packets/s of budget left at the probe, below the standby cap on a standby
	episode     int  // packets/s a new Episode reserves
	hostGuard   bool // the node's host guard refuses new Episodes, whatever budget is left
	incarnation string
	NodeHealth
	at time.Time
}

// fits reports whether the room left holds one more new Episode after the in-flight
// ones, which the probe may not include yet.
func (l nodeLoad) fits(inflight int) bool { return l.room >= (inflight+1)*l.episode }

// NodeHealth is what a node's last answered probe said about its drain.
type NodeHealth struct {
	// Draining means the node refuses new Episodes and keeps its live ones.
	Draining bool
	// Allocations is what the node holds for live Episodes. A restart without interruption
	// waits for it and CleanupDebt to reach zero.
	Allocations int
	CleanupDebt int
}

// NewFleet builds one adapter per node. They share one mTLS client.
func NewFleet(config runtimeconfig.ChalkSFUConfig, log *slog.Logger) (*Fleet, error) {
	if len(config.Nodes) == 0 {
		return nil, fmt.Errorf("%w: no nodes", ErrMissingConfig)
	}
	if !slices.ContainsFunc(config.Nodes, func(node runtimeconfig.ChalkSFUNode) bool { return node.Role != runtimeconfig.ChalkSFURoleStandby }) {
		return nil, fmt.Errorf("%w: no primary node", ErrMissingConfig)
	}
	client, err := newClient(config)
	if err != nil {
		return nil, err
	}
	fleet := &Fleet{
		applicationID: config.ApplicationID,
		overflow:      config.CloudflareOverflow,
		standbys:      map[string]bool{},
		standbyBudget: config.StandbyPacketBudget,
		log:           log,
		loads:         map[string]nodeLoad{},
		seen:          map[string]sighting{},
		inflight:      map[string][]time.Time{},
	}
	for _, node := range config.Nodes {
		adapter, err := newAdapter(config, node, client)
		if err != nil {
			return nil, err
		}
		fleet.nodes = append(fleet.nodes, adapter)
		if node.Role == runtimeconfig.ChalkSFURoleStandby {
			fleet.standbys[node.ID] = true
		}
	}
	return fleet, nil
}

// ApplicationID names the SFU pool for the Episode binding. It stays the same
// when nodes, hosts or certificates change.
func (f *Fleet) ApplicationID() string { return f.applicationID }

// CloudflareOverflow reports whether a new Episode may start on Cloudflare when
// no node has room.
func (f *Fleet) CloudflareOverflow() bool { return f.overflow }

// Node returns the adapter of the node an Episode is bound to.
func (f *Fleet) Node(id string) (*Adapter, error) {
	for _, node := range f.nodes {
		if node.node == id {
			return node, nil
		}
	}
	return nil, fmt.Errorf("%w: %w: node %q", mediaplane.ErrPlaneUnavailable, ErrUnknownNode, id)
}

// CapturePlane returns the recorder-facing plane of the node an Episode is bound to, issued under
// the binding's generation so the node refuses a capture once the Episode is retired above it.
func (f *Fleet) CapturePlane(id string, generation int64) (captureplane.CapturePlane, error) {
	node, err := f.Node(id)
	if err != nil {
		return nil, err
	}
	return node.Bound("", generation), nil
}

// Place picks the node for a new Episode. Primaries are tried first, in
// configuration order, and a standby only when no primary can take it (silent,
// draining, host-guard closed or out of budget). A node qualifies when its last
// probe is fresh, ready and has packet budget left for a new Episode, after the
// Episodes this process placed there in the last inflightTTL, so concurrent creations
// do not all pin to the last slot, even across a probe that does not show them yet. A standby counts only the
// degraded budget it is configured with. The first qualifying node wins and room
// is true. The placement then records the node, its boot incarnation from that
// probe and whether it is a primary or a standby. When no node qualifies after a
// probe, every node would refuse the Episode, so room is false and the caller may
// start it on another provider. The placement then names the first primary, the
// fallback when there is no other provider, and why nothing had room: a node that
// takes new Episodes was full, else a node's host guard refused them (spare budget
// or not), else every answering node was draining, else none answered.
// Before the first probe it reports the first primary with room, whose admission
// then answers the join. It reads the last probes and does no I/O, because
// Episode creation calls it inside a database transaction.
func (f *Fleet) Place() (placement mediaplane.Placement, room bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var answering, full, guarded bool // a node answered; a serving node was full; a serving node's host guard refused
	for _, standby := range []bool{false, true} {
		for _, node := range f.nodes {
			if f.standbys[node.node] != standby {
				continue
			}
			load, probed := f.loads[node.node]
			if !probed || time.Since(load.at) > probeFreshness {
				continue
			}
			answering = true
			switch {
			case load.Draining:
			case load.hostGuard:
				guarded = true
			case !load.fits(len(f.inflightOn(node.node))):
				full = true
			default:
				f.inflight[node.node] = append(f.inflight[node.node], time.Now())
				reason := mediaplane.PlacementPrimary
				if standby {
					reason = mediaplane.PlacementStandby
				}
				return mediaplane.Placement{Node: node.node, Incarnation: load.incarnation, Reason: reason}, true
			}
		}
	}
	first := mediaplane.Placement{Node: f.firstPrimary(), Reason: mediaplane.PlacementPrimary}
	if !f.probed {
		return first, true
	}
	switch {
	case full:
		first.Reason = mediaplane.PlacementOverflowNoRoom
	case guarded:
		first.Reason = mediaplane.PlacementOverflowHostGuard
	case answering:
		first.Reason = mediaplane.PlacementOverflowDraining
	default:
		first.Reason = mediaplane.PlacementOverflowNodeUnavailable
	}
	return first, false
}

// inflightOn returns the Episodes placed on a node less than inflightTTL ago and
// forgets older ones. It holds f.mu.
func (f *Fleet) inflightOn(node string) []time.Time {
	live := slices.DeleteFunc(f.inflight[node], func(at time.Time) bool { return time.Since(at) > inflightTTL })
	f.inflight[node] = live
	return live
}

// firstPrimary names the first primary in configuration order. NewFleet
// guarantees there is one.
func (f *Fleet) firstPrimary() string {
	for _, node := range f.nodes {
		if !f.standbys[node.node] {
			return node.node
		}
	}
	return ""
}

// Watch probes every node's readiness until ctx ends.
func (f *Fleet) Watch(ctx context.Context) {
	ticker := time.NewTicker(probeInterval)
	defer ticker.Stop()
	for {
		f.Probe(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// Health reports a node's drain state from its last probe. It reports false when the node did
// not answer recently, so a silent node reads as unknown rather than as serving.
func (f *Fleet) Health(node string) (NodeHealth, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	load, probed := f.loads[node]
	if !probed || time.Since(load.at) > probeFreshness {
		return NodeHealth{}, false
	}
	return load.NodeHealth, true
}

// Probe reads every node's readiness once, concurrently. A node that does not
// answer loses its load record and with it its place in placement. A draining
// node keeps a record that says so, and it too is out of placement.
func (f *Fleet) Probe(ctx context.Context) {
	var wg sync.WaitGroup
	for _, node := range f.nodes {
		wg.Go(func() { f.probeNode(ctx, node) })
	}
	wg.Wait()
	f.mu.Lock()
	if !f.probed {
		f.firstRound = time.Now()
	}
	f.probed = true
	f.mu.Unlock()
}

// probeNode asks one node for its readiness and records the answer.
func (f *Fleet) probeNode(ctx context.Context, node *Adapter) {
	probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	ready, err := node.ready(probeCtx)
	f.mu.Lock()
	defer f.mu.Unlock()
	before, known := f.loads[node.node]
	if err != nil {
		switch {
		case known && before.Draining:
			f.logTransition(ctx, slog.LevelInfo, "chalk sfu draining node stopped answering", node.node)
		case known:
			f.logTransition(ctx, slog.LevelWarn, "chalk sfu node left placement", node.node)
		}
		delete(f.loads, node.node)
		return
	}
	switch {
	case ready.Draining && !(known && before.Draining):
		f.logTransition(ctx, slog.LevelInfo, "chalk sfu node draining", node.node, "allocations", ready.Allocations, "cleanupDebt", ready.CleanupDebt)
	case !ready.Draining && known && before.Draining:
		f.logTransition(ctx, slog.LevelInfo, "chalk sfu node no longer draining", node.node)
	}
	now := time.Now()
	load := f.loadOf(node.node, ready, now)
	f.loads[node.node] = load
	f.seen[node.node] = sighting{at: now, incarnation: load.incarnation}
}

// loadOf turns a node's ready answer into its load record, with no placed
// Episodes. A standby's budget is capped at the degraded budget the Fleet is
// configured with.
func (f *Fleet) loadOf(node string, ready wireReady, at time.Time) nodeLoad {
	budget := ready.PacketBudget
	if f.standbys[node] {
		budget = min(budget, f.standbyBudget)
	}
	incarnation := ready.NodeIncarnation
	if !mediaplane.ValidIncarnation(incarnation) {
		incarnation = "" // a malformed value must not fail Episode creation
	}
	return nodeLoad{
		room:        budget - ready.ReservedPackets,
		episode:     ready.NewEpisodePackets,
		hostGuard:   ready.Host.AdmissionReason != "",
		incarnation: incarnation,
		NodeHealth:  NodeHealth{Draining: ready.Draining, Allocations: ready.Allocations, CleanupDebt: ready.CleanupDebt},
		at:          at,
	}
}

func (f *Fleet) logTransition(ctx context.Context, level slog.Level, message, node string, attrs ...any) {
	if f.log != nil {
		f.log.Log(ctx, level, message, append([]any{"node", node}, attrs...)...)
	}
}
