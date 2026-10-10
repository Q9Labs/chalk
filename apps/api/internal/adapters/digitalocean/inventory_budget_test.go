package digitalocean

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

func TestRecorderFleetInventoryRequestBudgetDoesNotGrowWithPool(t *testing.T) {
	for _, count := range []int{1, 10} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			request := recorderFleetEnsureRequest()
			calls := 0
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				switch r.URL.Path {
				case "/v2/droplets":
					droplets := make([]map[string]any, 0, count)
					for id := range count {
						droplets = append(droplets, dropletResponse(request, int64(id+1)))
					}
					writeJSON(t, w, http.StatusOK, map[string]any{"droplets": droplets})
				case "/v2/firewalls":
					writeJSON(t, w, http.StatusOK, map[string]any{"firewalls": []map[string]any{
						{"id": "firewall-1", "tags": []string{request.RequiredTags[0]}},
						{"id": "direct", "droplet_ids": []int64{1}},
						{"id": "unrelated", "droplet_ids": []int64{99}},
					}})
				default:
					// Base implementation reads the same attachment once per node.
					writeJSON(t, w, http.StatusOK, map[string]any{"firewalls": []map[string]any{{"id": "firewall-1"}}})
				}
			}))
			defer server.Close()
			adapter := recorderFleetAdapter(t, server, "token")
			nodes, err := adapter.ListNodes(t.Context(), request.Key)
			if err != nil || len(nodes) != count {
				t.Fatalf("inventory count/error = %d/%v", len(nodes), err)
			}
			if calls != 2 {
				t.Fatalf("inventory requests = %d, want 2 independent of pool size", calls)
			}
			for _, node := range nodes {
				want := []string{"firewall-1"}
				if node.ProviderID == "1" {
					want = []string{"direct", "firewall-1"}
				}
				if !slices.Equal(node.FirewallIDs, want) {
					t.Fatalf("firewall ownership for node %s = %v, want %v", node.ProviderID, node.FirewallIDs, want)
				}
			}
		})
	}
}

func TestRecorderFleetInventoryRequiresCompleteFirewallSnapshot(t *testing.T) {
	for _, failure := range []string{"none", "page failure", "foreign next page"} {
		t.Run(failure, func(t *testing.T) {
			request := recorderFleetEnsureRequest()
			var server *httptest.Server
			server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v2/droplets":
					writeJSON(t, w, http.StatusOK, map[string]any{"droplets": []map[string]any{dropletResponse(request, 1)}})
				case "/v2/firewalls":
					if r.URL.Query().Get("page") == "2" {
						if failure == "page failure" {
							w.WriteHeader(http.StatusServiceUnavailable)
							return
						}
						writeJSON(t, w, http.StatusOK, map[string]any{"firewalls": []map[string]any{{"id": "firewall-1", "droplet_ids": []int64{1}}}})
						return
					}
					next := server.URL + "/v2/firewalls?page=2"
					if failure == "foreign next page" {
						next = "https://foreign.example.test/v2/firewalls?page=2"
					}
					writeJSON(t, w, http.StatusOK, map[string]any{"firewalls": []map[string]any{}, "links": map[string]any{"pages": map[string]any{"next": next}}})
				default:
					t.Errorf("unexpected request %s", r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer server.Close()
			adapter := recorderFleetAdapter(t, server, "token")
			nodes, err := adapter.ListNodes(t.Context(), request.Key)
			if failure != "none" {
				if !errors.Is(err, recorderfleet.ErrProviderUnavailable) || len(nodes) != 0 {
					t.Fatalf("incomplete inventory exposed nodes: %v/%v", nodes, err)
				}
				return
			}
			if err != nil || len(nodes) != 1 || !slices.Equal(nodes[0].FirewallIDs, []string{"firewall-1"}) {
				t.Fatalf("paginated attachment = %v/%v", nodes, err)
			}
		})
	}
}
