package digitalocean

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
	"testing"
)

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
	fake := newFakeDigitalOcean(t, routes(nil, []map[string]any{goodFirewall()}))
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

func TestWrongAccountCannotConfirmAbsence(t *testing.T) {
	fake := newFakeDigitalOcean(t, routes(nil, nil))
	if _, found, err := fake.adapter().Inspect(t.Context(), testWindowName, 4242); found || !errors.Is(err, ErrSFUWindowFirewall) {
		t.Fatalf("found=%t err=%v, want unconfirmed with missing firewall", found, err)
	}
}

func TestObserveFindsOutdatedLaunchWithoutAdmittingItsImage(t *testing.T) {
	droplet := windowDroplet(func(value map[string]any) { value["image"] = map[string]any{"id": 5} })
	fake := newFakeDigitalOcean(t, routes([]map[string]any{droplet}, nil))
	observed, found, err := fake.adapter().Observe(t.Context(), testWindowName)
	if err != nil || !found || !observed.Outdated || observed.ID != 4242 {
		t.Fatalf("outdated launch was not recoverable: %+v %t %v", observed, found, err)
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
