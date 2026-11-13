package chalksfu

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"

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
	// minNodeProtocol is the lowest SFU wire protocol this API can send to. The API puts
	// allocationGeneration in its create, reserve, move and source-control bodies, and a node
	// below protocol 2 refuses a body with a field it does not know (400 invalid_request). The
	// API places no Episode on such a node, so deploying the API before the SFU degrades
	// placement visibly and fails no call.
	minNodeProtocol = 2
)

// sighting is a node's last answered probe. Unlike its load record, which a failed probe
// deletes so placement skips the node, it survives a failed probe, so one lost probe does not
// make a live node look lost.
type sighting struct {
	at          time.Time
	incarnation string
}

// verdict is whether a node can take this API's requests, learned from the protocol in its last
// answered /readyz. It is a fact about the node's build and survives a failed probe, unlike its
// load, so a node that falls silent stays known as compatible or as too old. A node with no
// verdict has never answered.
type verdict int

const (
	verdictUnknown verdict = iota
	verdictCompatible
	verdictTooOld
)

func verdictOf(protocol int) verdict {
	if protocol < minNodeProtocol {
		return verdictTooOld
	}
	return verdictCompatible
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
		// A missed probe keeps the last sample: it stays usable until probeFreshness
		// passes, so one lost probe neither removes a working node from placement nor
		// forgets whether it speaks the protocol. Only the first misses are logged.
		if known && time.Since(before.at) <= probeFreshness {
			if before.Draining {
				f.logTransition(ctx, slog.LevelInfo, "chalk sfu draining node stopped answering", node.node)
			} else {
				f.logTransition(ctx, slog.LevelWarn, "chalk sfu node missed a probe", node.node)
			}
		}
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
	seen := verdictOf(ready.Protocol)
	if seen == verdictTooOld && f.verdicts[node.node] != verdictTooOld {
		f.logTransition(ctx, slog.LevelWarn, "chalk sfu node is out of placement", node.node, "reason", NodeProtocolTooOld, "protocol", ready.Protocol, "minProtocol", minNodeProtocol, "revision", boundedRevision(ready.Revision))
	}
	f.verdicts[node.node] = seen
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

// NodeProtocolTooOld is the bounded reason a node is out of placement: it decodes an older wire
// protocol than this API sends. The same words name the placement reason overflow_node_protocol_too_old.
const NodeProtocolTooOld = "node_protocol_too_old"

// boundedRevision keeps a node-reported value out of the log unless it is a commit id.
func boundedRevision(revision string) string {
	if len(revision) != 40 || strings.Trim(revision, "0123456789abcdef") != "" {
		return ""
	}
	return revision
}

func (f *Fleet) logTransition(ctx context.Context, level slog.Level, message, node string, attrs ...any) {
	if f.log != nil {
		f.log.Log(ctx, level, message, append([]any{"node", node}, attrs...)...)
	}
}
