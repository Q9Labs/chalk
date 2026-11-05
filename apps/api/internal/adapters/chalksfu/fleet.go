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
	nodes         []*Adapter
	log           *slog.Logger

	mu    sync.Mutex
	loads map[string]nodeLoad
}

// nodeLoad is a node's last ready probe. A draining or silent node has none.
type nodeLoad struct {
	hasRoom bool // the budget left fits a new Episode
	at      time.Time
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
	fleet := &Fleet{applicationID: config.ApplicationID, log: log, loads: map[string]nodeLoad{}}
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
// has packet budget left for a new Episode wins. When no node qualifies, or
// before the first probe, it picks the first node, whose admission then
// answers the join. It reads the last probes and does no I/O, because Episode
// creation calls it inside a database transaction. A one-node pool always
// gets its one node.
func (f *Fleet) Place() string {
	if len(f.nodes) == 1 {
		return f.nodes[0].node
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, node := range f.nodes {
		load, probed := f.loads[node.node]
		if probed && load.hasRoom && time.Since(load.at) <= probeFreshness {
			return node.node
		}
	}
	return f.nodes[0].node
}

// Watch probes every node's readiness until ctx ends. A one-node pool never
// needs it, because placement has no choice to make.
func (f *Fleet) Watch(ctx context.Context) {
	if len(f.nodes) == 1 {
		return
	}
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

// Probe reads every node's readiness once, concurrently. A node that does not
// answer ready, a draining node's 503 included, loses its load record and with
// it its place in placement.
func (f *Fleet) Probe(ctx context.Context) {
	var wg sync.WaitGroup
	for _, node := range f.nodes {
		wg.Go(func() {
			probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
			defer cancel()
			ready, err := node.ready(probeCtx)
			f.mu.Lock()
			defer f.mu.Unlock()
			if err != nil {
				if _, known := f.loads[node.node]; known && f.log != nil {
					f.log.WarnContext(ctx, "chalk sfu node left placement", "node", node.node)
				}
				delete(f.loads, node.node)
				return
			}
			hasRoom := ready.PacketBudget-ready.ReservedPackets >= ready.NewEpisodePackets
			f.loads[node.node] = nodeLoad{hasRoom: hasRoom, at: time.Now()}
		})
	}
	wg.Wait()
}
