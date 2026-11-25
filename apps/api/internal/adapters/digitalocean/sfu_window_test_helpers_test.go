package digitalocean

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

const (
	testWindowToken       = "dop_v1_secret-token-value"
	testWindowName        = "window-sfu-0c1f6d2e-3b4a-4c5d-8e9f-a0b1c2d3e4f5"
	testWindowOwnerTag    = "chalk-window-sfu-env-staging"
	testWindowFirewallTag = "chalk-window-sfu-fw"
	testWindowFirewallID  = "11111111-2222-4333-8444-555555555555"
	testWindowVPC         = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
	testWindowRegion      = "fra1"
	testWindowSnapshot    = int64(987654321)
)

type recordedRequest struct {
	Method string
	Path   string
	Query  string
	Body   string
	Auth   string
}

type fakeDigitalOcean struct {
	t        *testing.T
	server   *httptest.Server
	mu       sync.Mutex
	requests []recordedRequest
	handler  func(w http.ResponseWriter, r *http.Request, body string)
}

func newFakeDigitalOcean(t *testing.T, handler func(w http.ResponseWriter, r *http.Request, body string)) *fakeDigitalOcean {
	t.Helper()
	fake := &fakeDigitalOcean{t: t, handler: handler}
	fake.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		fake.mu.Lock()
		fake.requests = append(fake.requests, recordedRequest{r.Method, r.URL.Path, r.URL.RawQuery, string(body), r.Header.Get("Authorization")})
		fake.mu.Unlock()
		fake.handler(w, r, string(body))
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

func (f *fakeDigitalOcean) count(method string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	total := 0
	for _, request := range f.requests {
		if request.Method == method {
			total++
		}
	}
	return total
}

func (f *fakeDigitalOcean) adapter(mutate ...func(*SFUWindowConfig)) *SFUWindow {
	f.t.Helper()
	config := SFUWindowConfig{
		Token: testWindowToken, BaseURL: f.server.URL, HTTPClient: f.server.Client(),
		OwnerTag: testWindowOwnerTag, FirewallTag: testWindowFirewallTag, FirewallID: testWindowFirewallID,
		SnapshotID: testWindowSnapshot, Region: testWindowRegion, VPCUUID: testWindowVPC,
	}
	for _, apply := range mutate {
		apply(&config)
	}
	adapter, err := NewSFUWindow(config)
	if err != nil {
		f.t.Fatalf("NewSFUWindow: %v", err)
	}
	return adapter
}

func windowDroplet(mutate ...func(map[string]any)) map[string]any {
	droplet := map[string]any{
		"id": 4242, "name": testWindowName, "status": "active", "size_slug": SFUWindowSize, "vpc_uuid": testWindowVPC,
		"region": map[string]any{"slug": testWindowRegion}, "image": map[string]any{"id": testWindowSnapshot},
		"tags": []string{testWindowOwnerTag, testWindowFirewallTag},
		"networks": map[string]any{"v4": []map[string]any{
			{"ip_address": "10.116.0.5", "type": "private"},
			{"ip_address": "203.0.113.10", "type": "public"},
		}},
	}
	for _, apply := range mutate {
		apply(droplet)
	}
	return droplet
}

func goodFirewall() map[string]any {
	return map[string]any{"id": testWindowFirewallID, "status": "succeeded", "tags": []string{testWindowFirewallTag}}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

// routes serves a droplet list, a firewall list, and records create and delete calls.
func routes(droplets []map[string]any, firewalls []map[string]any) func(http.ResponseWriter, *http.Request, string) {
	return func(w http.ResponseWriter, r *http.Request, body string) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v2/droplets":
			writeJSON(w, http.StatusOK, map[string]any{"droplets": droplets})
		case r.Method == http.MethodGet && r.URL.Path == "/v2/firewalls":
			writeJSON(w, http.StatusOK, map[string]any{"firewalls": firewalls})
		case r.Method == http.MethodPost && r.URL.Path == "/v2/droplets":
			writeJSON(w, http.StatusAccepted, map[string]any{"droplet": windowDroplet(func(d map[string]any) { d["status"] = "new" })})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v2/droplets/"):
			if len(droplets) == 0 {
				writeJSON(w, http.StatusNotFound, map[string]any{"id": "not_found"})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"droplet": droplets[0]})
		case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/v2/droplets/"):
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "unexpected", http.StatusTeapot)
		}
	}
}
