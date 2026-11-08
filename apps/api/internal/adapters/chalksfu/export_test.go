package chalksfu

import "time"

// SetRecoveryHold shortens how long a recovery's reservation waits for rejoins, so a test can
// outlast it.
func SetRecoveryHold(f *Fleet, seconds int) { f.holdSeconds = seconds }

// AgeSighting makes a node's last answer older than the freshness window, as a silent node's
// would be, without a test waiting out the window.
func AgeSighting(f *Fleet, node string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	seen := f.seen[node]
	seen.at = time.Now().Add(-2 * probeFreshness)
	f.seen[node] = seen
}

// Charged is how many recovered Episodes this Fleet counts against the node until its next probe.
func Charged(f *Fleet, node string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.inflight[node])
}

// MarkSilent makes this Fleet see the node as silent while the node itself keeps running, as a
// control-plane partition between one API replica and the node would.
func MarkSilent(f *Fleet, node string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.loads, node)
	seen := f.seen[node]
	seen.at = time.Now().Add(-2 * probeFreshness)
	f.seen[node] = seen
}
