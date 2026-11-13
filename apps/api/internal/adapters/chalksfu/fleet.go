package chalksfu

import (
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
	verdicts    map[string]verdict     // what each node's last answer said about its wire protocol; a failed probe leaves it alone
	inflight    map[string][]time.Time // when this process placed each recent Episode, by node; a probe leaves it alone
	probed      bool                   // a probe round has finished, so a node without a load record has none
	firstRound  time.Time              // when the first probe round finished
	holdSeconds int                    // how long a recovery's reservation waits for rejoins; zero means recoveryHoldSeconds
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
		verdicts:      map[string]verdict{},
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

// Allocation returns the adapter of the node an Episode is bound to, issued under the binding's
// boot incarnation (empty when the caller has none) and generation. Every create, source control
// and capture it sends names that generation, so the node refuses it once the Episode is retired
// above it. Production code reaches a node through here and not through Node, so no caller omits
// the generation.
func (f *Fleet) Allocation(id, incarnation string, generation int64) (*Adapter, error) {
	node, err := f.Node(id)
	if err != nil {
		return nil, err
	}
	return node.Bound(incarnation, generation), nil
}

// CapturePlane returns the recorder-facing plane of the allocation an Episode is bound to. The
// node refuses a capture once the Episode is retired above the generation, and the plane refuses
// an answer from another boot than the incarnation.
func (f *Fleet) CapturePlane(id, incarnation string, generation int64) (captureplane.CapturePlane, error) {
	return f.Allocation(id, incarnation, generation)
}

// Place picks the node for a new Episode. Primaries are tried first, in
// configuration order, and a standby only when no primary can take it (silent,
// draining, host-guard closed or out of budget). Only a node whose last answer showed a wire
// protocol of at least minNodeProtocol is eligible, so no Episode is bound to a node that is old
// or has not answered yet. A node qualifies when that holds, its last probe is fresh and ready,
// and it has packet budget left for a new Episode, after the Episodes this process placed there
// in the last inflightTTL, so concurrent creations do not all pin to the last slot, even across
// a probe that does not show them yet. A standby counts only the degraded budget it is configured
// with. The first qualifying node wins and room is true. The placement then records the node,
// its boot incarnation from that probe and whether it is a primary or a standby.
//
// A node whose protocol is below minNodeProtocol, or that has not yet answered a probe, never
// takes a new Episode. When no node qualifies, every node would refuse the Episode, so room is
// false, no node is named, and the caller starts the Episode on another provider or refuses it.
// The reason says why: a node that takes new Episodes was full, else a node's host guard refused
// them (spare budget or not), else every answering node was draining, else
// overflow_node_protocol_too_old when some node is known to be old, else overflow_node_unavailable.
//
// It reads the last probes and does no I/O, because Episode creation calls it inside a database
// transaction.
func (f *Fleet) Place() (placement mediaplane.Placement, room bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var answering, full, guarded, tooOld bool // a compatible node answered; one was full; one's host guard refused; some node is known to be old
	for _, standby := range []bool{false, true} {
		for _, node := range f.nodes {
			if f.standbys[node.node] != standby {
				continue
			}
			switch f.verdicts[node.node] {
			case verdictTooOld:
				tooOld = true
				continue
			case verdictUnknown:
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
	none := mediaplane.Placement{Reason: mediaplane.PlacementOverflowNodeUnavailable}
	switch {
	case full:
		none.Reason = mediaplane.PlacementOverflowNoRoom
	case guarded:
		none.Reason = mediaplane.PlacementOverflowHostGuard
	case answering:
		none.Reason = mediaplane.PlacementOverflowDraining
	case tooOld:
		none.Reason = mediaplane.PlacementOverflowNodeProtocol
	}
	return none, false
}

// inflightOn returns the Episodes placed on a node less than inflightTTL ago and
// forgets older ones. It holds f.mu.
func (f *Fleet) inflightOn(node string) []time.Time {
	live := slices.DeleteFunc(f.inflight[node], func(at time.Time) bool { return time.Since(at) > inflightTTL })
	f.inflight[node] = live
	return live
}
