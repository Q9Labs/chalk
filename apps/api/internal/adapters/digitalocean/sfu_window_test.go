package digitalocean

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
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

func TestNewSFUWindowRejectsInvalidConfig(t *testing.T) {
	valid := SFUWindowConfig{
		Token: testWindowToken, OwnerTag: testWindowOwnerTag, FirewallTag: testWindowFirewallTag, FirewallID: testWindowFirewallID,
		SnapshotID: testWindowSnapshot, Region: testWindowRegion, VPCUUID: testWindowVPC,
	}
	if _, err := NewSFUWindow(valid); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	cases := map[string]func(*SFUWindowConfig){
		"empty token":        func(c *SFUWindowConfig) { c.Token = "  " },
		"http base":          func(c *SFUWindowConfig) { c.BaseURL = "http://api.digitalocean.com" },
		"base with path":     func(c *SFUWindowConfig) { c.BaseURL = "https://api.digitalocean.com/v2" },
		"base with userinfo": func(c *SFUWindowConfig) { c.BaseURL = "https://user:pw@api.digitalocean.com" },
		"empty owner tag":    func(c *SFUWindowConfig) { c.OwnerTag = "" },
		"owner tag spaces":   func(c *SFUWindowConfig) { c.OwnerTag = "a b" },
		"same tags":          func(c *SFUWindowConfig) { c.FirewallTag = c.OwnerTag },
		"zero snapshot":      func(c *SFUWindowConfig) { c.SnapshotID = 0 },
		"negative snapshot":  func(c *SFUWindowConfig) { c.SnapshotID = -3 },
		"no vpc":             func(c *SFUWindowConfig) { c.VPCUUID = "" },
		"upper vpc":          func(c *SFUWindowConfig) { c.VPCUUID = strings.ToUpper(testWindowVPC) },
		"bad firewall id":    func(c *SFUWindowConfig) { c.FirewallID = "fw-1" },
		"bad region":         func(c *SFUWindowConfig) { c.Region = "Frankfurt" },
		"empty region":       func(c *SFUWindowConfig) { c.Region = "" },
	}
	for name, mutate := range cases {
		config := valid
		mutate(&config)
		if _, err := NewSFUWindow(config); !errors.Is(err, ErrSFUWindowInvalid) {
			t.Errorf("%s: got %v, want ErrSFUWindowInvalid", name, err)
		}
	}
}

func TestSFUWindowRejectsUnownedNames(t *testing.T) {
	fake := newFakeDigitalOcean(t, routes(nil, []map[string]any{goodFirewall()}))
	adapter := fake.adapter()
	for _, name := range []string{"", "sfu-1", "window-sfu-", "window-sfu-ABC", "window-sfu-0C1F6D2E-3B4A-4C5D-8E9F-A0B1C2D3E4F5", testWindowName + "x", "static-" + testWindowName} {
		if _, _, err := adapter.Observe(context.Background(), name); !errors.Is(err, ErrSFUWindowInvalid) {
			t.Errorf("Observe(%q) = %v", name, err)
		}
		if err := adapter.Create(context.Background(), name); !errors.Is(err, ErrSFUWindowInvalid) {
			t.Errorf("Create(%q) = %v", name, err)
		}
		if err := adapter.Destroy(context.Background(), name, 1); !errors.Is(err, ErrSFUWindowInvalid) {
			t.Errorf("Destroy(%q) = %v", name, err)
		}
	}
	if err := adapter.Destroy(context.Background(), testWindowName, 0); !errors.Is(err, ErrSFUWindowInvalid) {
		t.Errorf("Destroy id 0 = %v", err)
	}
	if len(fake.requests) != 0 {
		t.Fatalf("invalid input reached the provider: %+v", fake.requests)
	}
}

func TestObserveMissingAndActive(t *testing.T) {
	fake := newFakeDigitalOcean(t, routes(nil, nil))
	if _, found, err := fake.adapter().Observe(context.Background(), testWindowName); err != nil || found {
		t.Fatalf("missing droplet: found=%v err=%v", found, err)
	}

	other := windowDroplet(func(d map[string]any) {
		d["id"] = 7
		d["name"] = "window-sfu-ffffffff-3b4a-4c5d-8e9f-a0b1c2d3e4f5"
		d["tags"] = []string{"unrelated"}
	})
	fake = newFakeDigitalOcean(t, routes([]map[string]any{other, windowDroplet()}, nil))
	droplet, found, err := fake.adapter().Observe(context.Background(), testWindowName)
	if err != nil || !found {
		t.Fatalf("Observe: found=%v err=%v", found, err)
	}
	if droplet.ID != 4242 || droplet.Address != netip.MustParseAddr("203.0.113.10") || !droplet.Active {
		t.Fatalf("droplet = %+v", droplet)
	}
	request := fake.requests[0]
	if request.Method != http.MethodGet || request.Path != "/v2/droplets" || request.Auth != "Bearer "+testWindowToken || !strings.Contains(request.Query, "name="+testWindowName) {
		t.Fatalf("request = %+v", request)
	}
}

func TestObserveBootingHasNoActiveAddress(t *testing.T) {
	booting := windowDroplet(func(d map[string]any) { d["status"] = "new"; d["networks"] = map[string]any{"v4": []any{}} })
	fake := newFakeDigitalOcean(t, routes([]map[string]any{booting}, nil))
	droplet, found, err := fake.adapter().Observe(context.Background(), testWindowName)
	if err != nil || !found || droplet.Active || droplet.Address.IsValid() || droplet.ID != 4242 {
		t.Fatalf("droplet=%+v found=%v err=%v", droplet, found, err)
	}
	activeWithoutAddress := windowDroplet(func(d map[string]any) { d["networks"] = map[string]any{"v4": []any{}} })
	fake = newFakeDigitalOcean(t, routes([]map[string]any{activeWithoutAddress}, nil))
	droplet, _, err = fake.adapter().Observe(context.Background(), testWindowName)
	if err != nil || droplet.Active {
		t.Fatalf("active without address reported active: %+v err=%v", droplet, err)
	}
}

func TestObserveFailsClosedOnDuplicatesAndWrongOwnership(t *testing.T) {
	publicIP := func(address string) func(map[string]any) {
		return func(d map[string]any) {
			d["networks"] = map[string]any{"v4": []map[string]any{{"ip_address": address, "type": "public"}}}
		}
	}
	cases := map[string]func(map[string]any){
		"missing owner tag":     func(d map[string]any) { d["tags"] = []string{testWindowFirewallTag} },
		"other environment tag": func(d map[string]any) { d["tags"] = []string{"chalk-window-sfu-env-prod", testWindowFirewallTag} },
		"extra tag": func(d map[string]any) {
			d["tags"] = []string{testWindowOwnerTag, testWindowFirewallTag, "chalk-sfu-static"}
		},
		"only firewall tag":    func(d map[string]any) { d["tags"] = []string{testWindowFirewallTag} },
		"no tags":              func(d map[string]any) { d["tags"] = []string{} },
		"wrong size":           func(d map[string]any) { d["size_slug"] = "s-4vcpu-8gb" },
		"wrong region":         func(d map[string]any) { d["region"] = map[string]any{"slug": "nyc3"} },
		"wrong vpc":            func(d map[string]any) { d["vpc_uuid"] = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
		"no vpc":               func(d map[string]any) { delete(d, "vpc_uuid") },
		"wrong image":          func(d map[string]any) { d["image"] = map[string]any{"id": 1} },
		"case variant name":    func(d map[string]any) { d["name"] = strings.ToUpper(testWindowName) },
		"private public ip":    publicIP("10.0.0.9"),
		"loopback public ip":   publicIP("127.0.0.1"),
		"unparsable public ip": publicIP("evil.example.com"),
		"ipv6 public ip":       publicIP("2001:db8::1"),
		"two public ips": func(d map[string]any) {
			d["networks"] = map[string]any{"v4": []map[string]any{{"ip_address": "203.0.113.10", "type": "public"}, {"ip_address": "203.0.113.11", "type": "public"}}}
		},
	}
	for name, mutate := range cases {
		fake := newFakeDigitalOcean(t, routes([]map[string]any{windowDroplet(mutate)}, nil))
		_, found, err := fake.adapter().Observe(context.Background(), testWindowName)
		if !errors.Is(err, ErrSFUWindowDrift) || found {
			t.Errorf("%s: found=%v err=%v", name, found, err)
		}
	}

	fake := newFakeDigitalOcean(t, routes([]map[string]any{windowDroplet(), windowDroplet(func(d map[string]any) { d["id"] = 4243 })}, nil))
	if _, found, err := fake.adapter().Observe(context.Background(), testWindowName); !errors.Is(err, ErrSFUWindowDuplicate) || found {
		t.Fatalf("owned duplicate: found=%v err=%v", found, err)
	}
	foreignTwin := windowDroplet(func(d map[string]any) { d["id"] = 4243; d["tags"] = []string{"someone-else"} })
	fake = newFakeDigitalOcean(t, routes([]map[string]any{windowDroplet(), foreignTwin}, nil))
	if _, _, err := fake.adapter().Observe(context.Background(), testWindowName); !errors.Is(err, ErrSFUWindowDuplicate) {
		t.Fatalf("foreign twin: %v", err)
	}
}

func TestObserveFollowsOnlyTrustedPageLinks(t *testing.T) {
	var fake *fakeDigitalOcean
	fake = newFakeDigitalOcean(t, func(w http.ResponseWriter, r *http.Request, _ string) {
		if r.URL.Query().Get("page") == "2" {
			writeJSON(w, http.StatusOK, map[string]any{"droplets": []map[string]any{windowDroplet()}})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"droplets": []any{}, "links": map[string]any{"pages": map[string]any{"next": fake.server.URL + "/v2/droplets?page=2&per_page=200&name=" + testWindowName}}})
	})
	if _, found, err := fake.adapter().Observe(context.Background(), testWindowName); err != nil || !found {
		t.Fatalf("second page: found=%v err=%v", found, err)
	}

	for name, next := range map[string]string{
		"foreign host": "https://evil.example.com/v2/droplets?page=2",
		"other path":   "/v2/account/keys?page=2",
		"http scheme":  "http://127.0.0.1/v2/droplets?page=2",
	} {
		next := next
		fake := newFakeDigitalOcean(t, func(w http.ResponseWriter, r *http.Request, _ string) {
			writeJSON(w, http.StatusOK, map[string]any{"droplets": []any{}, "links": map[string]any{"pages": map[string]any{"next": next}}})
		})
		if _, _, err := fake.adapter().Observe(context.Background(), testWindowName); !errors.Is(err, ErrSFUWindowProvider) {
			t.Errorf("%s: %v", name, err)
		}
		if len(fake.requests) != 1 {
			t.Errorf("%s: followed the link, %d requests", name, len(fake.requests))
		}
	}

	endless := newFakeDigitalOcean(t, nil)
	endless.handler = func(w http.ResponseWriter, r *http.Request, _ string) {
		writeJSON(w, http.StatusOK, map[string]any{"droplets": []any{}, "links": map[string]any{"pages": map[string]any{"next": endless.server.URL + "/v2/droplets?page=9"}}})
	}
	if _, _, err := endless.adapter().Observe(context.Background(), testWindowName); !errors.Is(err, ErrSFUWindowProvider) || len(endless.requests) != sfuWindowMaxPages {
		t.Fatalf("endless pages: err=%v requests=%d", err, len(endless.requests))
	}
}

func TestResponsesAreBoundedAndRedirectsNotFollowed(t *testing.T) {
	fake := newFakeDigitalOcean(t, func(w http.ResponseWriter, r *http.Request, _ string) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"droplets":[],"padding":"` + strings.Repeat("a", maximumResponseBytes) + `"}`))
	})
	if _, _, err := fake.adapter().Observe(context.Background(), testWindowName); !errors.Is(err, ErrSFUWindowProvider) {
		t.Fatalf("oversized body: %v", err)
	}

	trap := newFakeDigitalOcean(t, func(w http.ResponseWriter, r *http.Request, _ string) { t.Error("redirect target was requested") })
	fake = newFakeDigitalOcean(t, func(w http.ResponseWriter, r *http.Request, _ string) {
		http.Redirect(w, r, trap.server.URL+"/v2/droplets", http.StatusTemporaryRedirect)
	})
	if _, _, err := fake.adapter().Observe(context.Background(), testWindowName); !errors.Is(err, ErrSFUWindowProvider) {
		t.Fatalf("redirect: %v", err)
	}
	if len(trap.requests) != 0 {
		t.Fatalf("redirect followed: %+v", trap.requests)
	}
}

func TestProviderErrorsDoNotLeakTheToken(t *testing.T) {
	fake := newFakeDigitalOcean(t, func(w http.ResponseWriter, r *http.Request, _ string) {
		http.Error(w, "boom "+r.Header.Get("Authorization"), http.StatusInternalServerError)
	})
	_, _, err := fake.adapter().Observe(context.Background(), testWindowName)
	if !errors.Is(err, ErrSFUWindowProvider) || strings.Contains(err.Error(), testWindowToken) {
		t.Fatalf("err = %v", err)
	}
}

func TestCreateSendsExactPinnedRequest(t *testing.T) {
	fake := newFakeDigitalOcean(t, routes(nil, []map[string]any{goodFirewall(), {"id": "99999999-2222-4333-8444-555555555555", "status": "succeeded", "tags": []string{"unrelated"}}}))
	if err := fake.adapter().Create(context.Background(), testWindowName); err != nil {
		t.Fatalf("Create: %v", err)
	}
	var methods []string
	for _, request := range fake.requests {
		methods = append(methods, request.Method+" "+request.Path)
	}
	if want := []string{"GET /v2/firewalls", "GET /v2/droplets", "POST /v2/droplets"}; !slices.Equal(methods, want) {
		t.Fatalf("requests = %v, want %v", methods, want)
	}
	post := fake.requests[2]
	var body map[string]any
	if err := json.Unmarshal([]byte(post.Body), &body); err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(body))
	for key := range body {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	if want := []string{"backups", "image", "ipv6", "monitoring", "name", "region", "size", "tags", "vpc_uuid", "with_droplet_agent"}; !slices.Equal(keys, want) {
		t.Fatalf("create body keys = %v, want %v (no user_data, no ssh_keys)", keys, want)
	}
	tags, _ := json.Marshal(body["tags"])
	if body["name"] != testWindowName || body["size"] != SFUWindowSize || body["region"] != testWindowRegion || body["vpc_uuid"] != testWindowVPC ||
		body["image"] != float64(testWindowSnapshot) || string(tags) != `["`+testWindowOwnerTag+`","`+testWindowFirewallTag+`"]` ||
		body["monitoring"] != false || body["with_droplet_agent"] != false || body["ipv6"] != false || body["backups"] != false {
		t.Fatalf("create body = %s", post.Body)
	}
	if post.Auth != "Bearer "+testWindowToken {
		t.Fatalf("auth = %q", post.Auth)
	}
}

func TestCreateRefusesDisagreeingFirewallBeforeAnyPost(t *testing.T) {
	other := "99999999-2222-4333-8444-555555555555"
	cases := map[string][]map[string]any{
		"no firewalls":                 {},
		"firewall not listed":          {{"id": other, "status": "succeeded", "tags": []string{"unrelated"}}},
		"still applying":               {{"id": testWindowFirewallID, "status": "waiting", "tags": []string{testWindowFirewallTag}}},
		"failed":                       {{"id": testWindowFirewallID, "status": "failed", "tags": []string{testWindowFirewallTag}}},
		"not tag targeted":             {{"id": testWindowFirewallID, "status": "succeeded", "tags": []string{}}},
		"also targets owner":           {{"id": testWindowFirewallID, "status": "succeeded", "tags": []string{testWindowFirewallTag, testWindowOwnerTag}}},
		"also targets another":         {{"id": testWindowFirewallID, "status": "succeeded", "tags": []string{testWindowFirewallTag, "static-sfu"}}},
		"second firewall on fw tag":    {goodFirewall(), {"id": other, "status": "succeeded", "tags": []string{testWindowFirewallTag}}},
		"second firewall on owner tag": {goodFirewall(), {"id": other, "status": "succeeded", "tags": []string{testWindowOwnerTag}}},
	}
	for name, firewalls := range cases {
		fake := newFakeDigitalOcean(t, routes(nil, firewalls))
		if err := fake.adapter().Create(context.Background(), testWindowName); !errors.Is(err, ErrSFUWindowFirewall) || errors.Is(err, ErrSFUWindowCreateUnknown) {
			t.Errorf("%s: err = %v", name, err)
		}
		if fake.count(http.MethodPost) != 0 {
			t.Errorf("%s: POST sent", name)
		}
	}
}

func TestCreateRefusesExistingNodeBeforeAnyPost(t *testing.T) {
	fake := newFakeDigitalOcean(t, routes([]map[string]any{windowDroplet()}, []map[string]any{goodFirewall()}))
	err := fake.adapter().Create(context.Background(), testWindowName)
	if !errors.Is(err, ErrSFUWindowExists) || errors.Is(err, ErrSFUWindowCreateUnknown) || fake.count(http.MethodPost) != 0 {
		t.Fatalf("existing: err=%v posts=%d", err, fake.count(http.MethodPost))
	}
	foreign := windowDroplet(func(d map[string]any) { d["tags"] = []string{"someone-else"} })
	fake = newFakeDigitalOcean(t, routes([]map[string]any{foreign}, []map[string]any{goodFirewall()}))
	err = fake.adapter().Create(context.Background(), testWindowName)
	if !errors.Is(err, ErrSFUWindowDrift) || errors.Is(err, ErrSFUWindowCreateUnknown) || fake.count(http.MethodPost) != 0 {
		t.Fatalf("foreign same name: err=%v posts=%d", err, fake.count(http.MethodPost))
	}
}

func TestCreatePreflightProviderFailureSentNoPost(t *testing.T) {
	fake := newFakeDigitalOcean(t, func(w http.ResponseWriter, r *http.Request, _ string) { http.Error(w, "down", http.StatusBadGateway) })
	err := fake.adapter().Create(context.Background(), testWindowName)
	if !errors.Is(err, ErrSFUWindowProvider) || errors.Is(err, ErrSFUWindowCreateUnknown) || fake.count(http.MethodPost) != 0 {
		t.Fatalf("err=%v posts=%d", err, fake.count(http.MethodPost))
	}
}

func TestCreateAmbiguityIsAlwaysPotentiallyCommittedAndNeverRetried(t *testing.T) {
	post := func(respond func(http.ResponseWriter, *http.Request)) func(http.ResponseWriter, *http.Request, string) {
		base := routes(nil, []map[string]any{goodFirewall()})
		return func(w http.ResponseWriter, r *http.Request, body string) {
			if r.Method == http.MethodPost {
				respond(w, r)
				return
			}
			base(w, r, body)
		}
	}
	trap := newFakeDigitalOcean(t, func(w http.ResponseWriter, r *http.Request, _ string) { t.Error("redirect target was requested") })
	cases := map[string]func(http.ResponseWriter, *http.Request){
		"server error": func(w http.ResponseWriter, r *http.Request) { http.Error(w, "boom", http.StatusInternalServerError) },
		"bad gateway":  func(w http.ResponseWriter, r *http.Request) { http.Error(w, "boom", http.StatusBadGateway) },
		"rate limited": func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Retry-After", "30")
			http.Error(w, "slow", http.StatusTooManyRequests)
		},
		"unprocessable": func(w http.ResponseWriter, r *http.Request) { http.Error(w, "no", http.StatusUnprocessableEntity) },
		"redirect": func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, trap.server.URL+"/v2/droplets", http.StatusTemporaryRedirect)
		},
		"ok instead of 202": func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{"droplet": windowDroplet()})
		},
		"garbled accepted": func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte("{not json"))
		},
		"empty accepted": func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusAccepted) },
		"accepted other droplet": func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusAccepted, map[string]any{"droplet": windowDroplet(func(d map[string]any) { d["name"] = "window-sfu-ffffffff-3b4a-4c5d-8e9f-a0b1c2d3e4f5" })})
		},
		"accepted wrong tags": func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusAccepted, map[string]any{"droplet": windowDroplet(func(d map[string]any) { d["tags"] = []string{"other"} })})
		},
		"connection dropped": func(w http.ResponseWriter, r *http.Request) {
			connection, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				_ = connection.Close()
			}
		},
	}
	for name, respond := range cases {
		fake := newFakeDigitalOcean(t, post(respond))
		err := fake.adapter().Create(context.Background(), testWindowName)
		if !errors.Is(err, ErrSFUWindowCreateUnknown) {
			t.Errorf("%s: err = %v, want ErrSFUWindowCreateUnknown", name, err)
		}
		if fake.count(http.MethodPost) != 1 {
			t.Errorf("%s: %d POSTs, want exactly 1 (no retry)", name, fake.count(http.MethodPost))
		}
		if err != nil && strings.Contains(err.Error(), testWindowToken) {
			t.Errorf("%s: error leaks the token", name)
		}
	}
	if len(trap.requests) != 0 {
		t.Fatalf("redirect followed: %+v", trap.requests)
	}

	limited := newFakeDigitalOcean(t, post(cases["rate limited"]))
	var rateLimit *SFUWindowRateLimitError
	if err := limited.adapter().Create(context.Background(), testWindowName); !errors.As(err, &rateLimit) || !rateLimit.RetryAt.After(time.Now()) {
		t.Fatalf("rate limit not surfaced: %v", err)
	}
}

func TestCreateTimeoutIsUnknownOutcome(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	fake := newFakeDigitalOcean(t, nil)
	base := routes(nil, []map[string]any{goodFirewall()})
	fake.handler = func(w http.ResponseWriter, r *http.Request, body string) {
		if r.Method == http.MethodPost {
			select {
			case <-release:
			case <-r.Context().Done():
			}
			return
		}
		base(w, r, body)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if err := fake.adapter().Create(ctx, testWindowName); !errors.Is(err, ErrSFUWindowCreateUnknown) {
		t.Fatalf("err = %v", err)
	}
}

func TestConcurrentCreateOfOneNameSendsOnePost(t *testing.T) {
	var mu sync.Mutex
	created := false
	fake := newFakeDigitalOcean(t, nil)
	fake.handler = func(w http.ResponseWriter, r *http.Request, _ string) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case r.URL.Path == "/v2/firewalls":
			writeJSON(w, http.StatusOK, map[string]any{"firewalls": []map[string]any{goodFirewall()}})
		case r.Method == http.MethodGet:
			droplets := []map[string]any{}
			if created {
				droplets = append(droplets, windowDroplet())
			}
			writeJSON(w, http.StatusOK, map[string]any{"droplets": droplets})
		case r.Method == http.MethodPost:
			created = true
			writeJSON(w, http.StatusAccepted, map[string]any{"droplet": windowDroplet()})
		}
	}
	adapter := fake.adapter()
	var wait sync.WaitGroup
	results := make([]error, 4)
	for index := range results {
		wait.Add(1)
		go func() {
			defer wait.Done()
			results[index] = adapter.Create(context.Background(), testWindowName)
		}()
	}
	wait.Wait()
	if fake.count(http.MethodPost) != 1 {
		t.Fatalf("%d POSTs for one name", fake.count(http.MethodPost))
	}
}

func TestDestroyReadsBackByIDThenDeletesByIDOnly(t *testing.T) {
	fake := newFakeDigitalOcean(t, routes([]map[string]any{windowDroplet(func(d map[string]any) { d["image"] = map[string]any{"id": 5} })}, nil))
	if err := fake.adapter().Destroy(context.Background(), testWindowName, 4242); err != nil {
		t.Fatalf("Destroy: %v", err)
	}
	want := []recordedRequest{
		{Method: http.MethodGet, Path: "/v2/droplets/4242", Auth: "Bearer " + testWindowToken},
		{Method: http.MethodDelete, Path: "/v2/droplets/4242", Auth: "Bearer " + testWindowToken},
	}
	if !slices.Equal(fake.requests, want) {
		t.Fatalf("requests = %+v, want %+v (a rolled snapshot must not block teardown; no query, no tag delete)", fake.requests, want)
	}
}

func TestDestroyMissingDropletIsIdempotent(t *testing.T) {
	fake := newFakeDigitalOcean(t, routes(nil, nil))
	if err := fake.adapter().Destroy(context.Background(), testWindowName, 4242); err != nil || fake.count(http.MethodDelete) != 0 {
		t.Fatalf("read-back 404: err=%v deletes=%d", err, fake.count(http.MethodDelete))
	}

	base := routes([]map[string]any{windowDroplet()}, nil)
	fake = newFakeDigitalOcean(t, func(w http.ResponseWriter, r *http.Request, body string) {
		if r.Method == http.MethodDelete {
			writeJSON(w, http.StatusNotFound, map[string]any{"id": "not_found"})
			return
		}
		base(w, r, body)
	})
	if err := fake.adapter().Destroy(context.Background(), testWindowName, 4242); err != nil {
		t.Fatalf("delete 404: %v", err)
	}
}

func TestDestroyNeverDeletesWrongOwnership(t *testing.T) {
	cases := map[string]func(map[string]any){
		"missing owner tag": func(d map[string]any) { d["tags"] = []string{testWindowFirewallTag} },
		"other env tag":     func(d map[string]any) { d["tags"] = []string{"chalk-window-sfu-env-prod", testWindowFirewallTag} },
		"extra tag":         func(d map[string]any) { d["tags"] = []string{testWindowOwnerTag, testWindowFirewallTag, "static"} },
		"different name":    func(d map[string]any) { d["name"] = "window-sfu-ffffffff-3b4a-4c5d-8e9f-a0b1c2d3e4f5" },
		"static name":       func(d map[string]any) { d["name"] = "sfu-static-1" },
		"wrong size":        func(d map[string]any) { d["size_slug"] = "s-8vcpu-16gb" },
		"wrong region":      func(d map[string]any) { d["region"] = map[string]any{"slug": "sfo3"} },
		"wrong vpc":         func(d map[string]any) { d["vpc_uuid"] = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
		"different id":      func(d map[string]any) { d["id"] = 9999 },
	}
	for name, mutate := range cases {
		fake := newFakeDigitalOcean(t, routes([]map[string]any{windowDroplet(mutate)}, nil))
		err := fake.adapter().Destroy(context.Background(), testWindowName, 4242)
		if !errors.Is(err, ErrSFUWindowDrift) {
			t.Errorf("%s: err = %v", name, err)
		}
		if fake.count(http.MethodDelete) != 0 {
			t.Errorf("%s: DELETE sent for a droplet this adapter does not own", name)
		}
	}
}

func TestDestroyProviderFailures(t *testing.T) {
	base := routes([]map[string]any{windowDroplet()}, nil)
	fake := newFakeDigitalOcean(t, func(w http.ResponseWriter, r *http.Request, body string) {
		if r.Method == http.MethodDelete {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		base(w, r, body)
	})
	if err := fake.adapter().Destroy(context.Background(), testWindowName, 4242); !errors.Is(err, ErrSFUWindowProvider) {
		t.Fatalf("delete 500: %v", err)
	}
	fake = newFakeDigitalOcean(t, func(w http.ResponseWriter, r *http.Request, _ string) {
		http.Error(w, "boom", http.StatusInternalServerError)
	})
	if err := fake.adapter().Destroy(context.Background(), testWindowName, 4242); !errors.Is(err, ErrSFUWindowProvider) || fake.count(http.MethodDelete) != 0 {
		t.Fatalf("read-back 500: err=%v", err)
	}
}

func TestValidationHelpers(t *testing.T) {
	for _, region := range []string{"fra1", "nyc3", "sfo3", "ams3", "tor1", "blr1", "syd1", "lon1", "sgp1", "atl1"} {
		if !validRegionSlug(region) {
			t.Errorf("region %q rejected", region)
		}
	}
	for _, region := range []string{"", "fra", "FRA1", "fra-1", "fra123", "1fra"} {
		if validRegionSlug(region) {
			t.Errorf("region %q accepted", region)
		}
	}
	if !validSFUWindowName(testWindowName) || validSFUWindowName(strings.Replace(testWindowName, "window", "static", 1)) {
		t.Fatal("name validation")
	}
}
