package chalksfu

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// A node that swallows the retire call must not use up the time the next node needs: each node
// gets its own bound.
func TestARetireThatOneNodeSwallowsStillReachesTheNextNode(t *testing.T) {
	release := make(chan struct{})
	swallowing := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { <-release }))
	t.Cleanup(swallowing.Close)
	t.Cleanup(func() { close(release) }) // runs first: Close waits for the handler
	var reached atomic.Int32
	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/episodes/retire" {
			reached.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"closed":1,"floor":2}`))
	}))
	t.Cleanup(healthy.Close)

	adapterOf := func(id string, server *httptest.Server) *Adapter {
		base, err := url.Parse(server.URL)
		if err != nil {
			t.Fatal(err)
		}
		return &Adapter{node: id, base: base, client: server.Client(), backoff: time.Millisecond}
	}
	fleet := &Fleet{standbys: map[string]bool{}, loads: map[string]nodeLoad{}, seen: map[string]sighting{}, inflight: map[string][]time.Time{}, probed: true, firstRound: time.Now().Add(-2 * probeFreshness)}
	fleet.nodes = []*Adapter{adapterOf("swallowing", swallowing), adapterOf("healthy", healthy), adapterOf("current", healthy)}
	for _, id := range []string{"swallowing", "healthy", "current"} {
		fleet.seen[id] = sighting{at: time.Now(), incarnation: "boot-" + id}
	}
	ctx := context.Background()
	settled, err := fleet.RetireAllocation(ctx, mediaplane.Allocation{Node: "swallowing", Incarnation: "boot-swallowing"}, "tenant", "episode", 2)
	if settled || err == nil {
		t.Fatalf("a node that never answered counted as settled: %v, %v", settled, err)
	}
	settled, err = fleet.RetireAllocation(ctx, mediaplane.Allocation{Node: "healthy", Incarnation: "boot-healthy"}, "tenant", "episode", 2)
	if !settled || err != nil || reached.Load() == 0 {
		t.Fatalf("the healthy node's retire: settled %v, err %v, reached %d", settled, err, reached.Load())
	}
}
