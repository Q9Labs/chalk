package chalksfu

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

const (
	probeInterval = 2 * time.Second
	probeTimeout  = time.Second
	// A probe older than this no longer counts, so a node that stops answering
	// leaves placement within a few intervals.
	probeFreshness = 3 * probeInterval
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
	log           *slog.Logger

	mu     sync.Mutex
	loads  map[string]nodeLoad
	probed bool // a probe round has finished, so a node without a load record has none
}

// nodeLoad is a node's last answered probe. A silent node has none. A draining node has one with
// hasRoom false, so placement skips it, and is told apart from a silent node.
type nodeLoad struct {
	hasRoom     bool // the budget left fits a new Episode
	hostGuard   bool // the node's host guard refuses new Episodes, whatever budget is left
	incarnation string
	NodeHealth
	at time.Time
}

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
	client, err := newClient(config)
	if err != nil {
		return nil, err
	}
	fleet := &Fleet{applicationID: config.ApplicationID, overflow: config.CloudflareOverflow, log: log, loads: map[string]nodeLoad{}}
	for _, node := range config.Nodes {
		adapter, err := newAdapter(config, node, client)
		if err != nil {
			return nil, err
		}
		fleet.nodes = append(fleet.nodes, adapter)
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

// Place picks the node for a new Episode. Nodes are tried in configuration
// order, so the first one is the primary and later ones are standbys of any
// size: the first node whose last probe is fresh, ready (so not draining) and
// has packet budget left for a new Episode wins, and room is true. The placement
// then records the node, its boot incarnation from that probe and whether it is
// the primary or a standby. When no node qualifies after a probe, every node
// would refuse the Episode, so room is false and the caller may start it on
// another provider. The placement then names the first node, the fallback when
// there is no other provider, and why nothing had room: a node that takes new
// Episodes was full, else a node's host guard refused them (spare budget or
// not), else every answering node was draining, else none answered.
// Before the first probe it reports the first node with room, whose admission
// then answers the join. It reads the last probes and does no I/O, because
// Episode creation calls it inside a database transaction.
func (f *Fleet) Place() (placement mediaplane.Placement, room bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var answering, full, guarded bool // a node answered; a serving node was full; a serving node's host guard refused
	for index, node := range f.nodes {
		load, probed := f.loads[node.node]
		if !probed || time.Since(load.at) > probeFreshness {
			continue
		}
		answering = true
		if !load.hasRoom {
			switch {
			case load.Draining:
			case load.hostGuard:
				guarded = true
			default:
				full = true
			}
			continue
		}
		reason := mediaplane.PlacementPrimary
		if index > 0 {
			reason = mediaplane.PlacementStandby
		}
		return mediaplane.Placement{Node: node.node, Incarnation: load.incarnation, Reason: reason}, true
	}
	first := mediaplane.Placement{Node: f.nodes[0].node, Reason: mediaplane.PlacementPrimary}
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
		wg.Go(func() {
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
			hostGuard := ready.Host.AdmissionReason != ""
			hasRoom := !ready.Draining && !hostGuard && ready.PacketBudget-ready.ReservedPackets >= ready.NewEpisodePackets
			incarnation := ready.NodeIncarnation
			if !mediaplane.ValidIncarnation(incarnation) {
				incarnation = "" // a malformed value must not fail Episode creation
			}
			f.loads[node.node] = nodeLoad{
				hasRoom:     hasRoom,
				hostGuard:   hostGuard,
				incarnation: incarnation,
				NodeHealth:  NodeHealth{Draining: ready.Draining, Allocations: ready.Allocations, CleanupDebt: ready.CleanupDebt},
				at:          time.Now(),
			}
		})
	}
	wg.Wait()
	f.mu.Lock()
	f.probed = true
	f.mu.Unlock()
}

func (f *Fleet) logTransition(ctx context.Context, level slog.Level, message, node string, attrs ...any) {
	if f.log != nil {
		f.log.Log(ctx, level, message, append([]any{"node", node}, attrs...)...)
	}
}
