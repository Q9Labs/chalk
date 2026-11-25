package digitalocean

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

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
		if err == nil || errors.Is(err, ErrSFUWindowCreateUnknown) == (name == "rate limited") {
			t.Errorf("%s: unexpected classification: %v", name, err)
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
	adapter := limited.adapter()
	if err := adapter.Create(context.Background(), testWindowName); !errors.As(err, &rateLimit) || !rateLimit.RetryAt.After(time.Now()) {
		t.Fatalf("rate limit not surfaced: %v", err)
	}
	before := len(limited.requests)
	if err := adapter.Create(context.Background(), testWindowName); !errors.As(err, &rateLimit) || len(limited.requests) != before {
		t.Fatalf("retried despite provider deadline: %v", err)
	}
	rejected := newFakeDigitalOcean(t, post(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnprocessableEntity)
	}))
	if err := rejected.adapter().Create(context.Background(), testWindowName); err == nil || errors.Is(err, ErrSFUWindowCreateUnknown) {
		t.Fatalf("422 was not a definitive rejection: %v", err)
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
