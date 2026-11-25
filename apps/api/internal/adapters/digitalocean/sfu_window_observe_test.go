package digitalocean

import (
	"context"
	"errors"
	"net/http"
	"net/netip"
	"strings"
	"testing"
)

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
