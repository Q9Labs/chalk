package sfu

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

const fakeTurnResponse = `{"iceServers":[
	{"urls":["stun:stun.cloudflare.com:3478"]},
	{"urls":["turn:turn.cloudflare.com:3478?transport=udp","turn:turn.cloudflare.com:3478?transport=tcp","turns:turn.cloudflare.com:443?transport=tcp"],"username":"minted-user","credential":"minted-secret"}
]}`

type fakeTurnAPI struct {
	status   int
	requests atomic.Int32
	path     atomic.Value
	auth     atomic.Value
	ttl      atomic.Int64
}

func (f *fakeTurnAPI) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		f.requests.Add(1)
		f.path.Store(r.URL.Path)
		f.auth.Store(r.Header.Get("Authorization"))
		var body struct {
			TTL int64 `json:"ttl"`
		}
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Errorf("TURN request body is not JSON: %v", err)
		}
		f.ttl.Store(body.TTL)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(f.status)
		_, _ = w.Write([]byte(fakeTurnResponse))
	}
}

func turnAdapter(t *testing.T, fake *fakeTurnAPI, keyID, token string) Adapter {
	t.Helper()
	server := httptest.NewServer(fake.handler(t))
	t.Cleanup(server.Close)
	adapter, err := NewAdapterWithClient(config.CloudflareRealtimeConfig{
		RealtimeAppID: "app", RealtimeAppSecret: "sfu-secret", TurnKeyID: keyID, TurnAPIToken: token, RequestTimeout: time.Second,
	}, server.Client(), server.URL)
	if err != nil {
		t.Fatal(err)
	}
	return adapter
}

func turnURLs(servers []mediaplane.ICEServer) []string {
	var urls []string
	for _, server := range servers {
		if server.Username == "" {
			continue
		}
		urls = append(urls, server.URLs...)
	}
	return urls
}

func TestIceServersMintTurnCredentialsFromCloudflare(t *testing.T) {
	fake := &fakeTurnAPI{status: http.StatusCreated}
	adapter := turnAdapter(t, fake, "key-id", "turn-api-token")

	servers := adapter.iceServers(context.Background())

	if fake.path.Load() != "/turn/keys/key-id/credentials/generate-ice-servers" {
		t.Fatalf("unexpected mint path %v", fake.path.Load())
	}
	if fake.auth.Load() != "Bearer turn-api-token" {
		t.Fatal("mint request must authenticate with the TURN API token")
	}
	if fake.ttl.Load() != int64(turnCredentialTTL/time.Second) {
		t.Fatalf("unexpected ttl %d", fake.ttl.Load())
	}
	urls := turnURLs(servers)
	if len(urls) != 3 || !strings.HasPrefix(urls[0], "turn:") || !strings.HasPrefix(urls[2], "turns:") || !strings.Contains(urls[2], ":443") {
		t.Fatalf("expected udp, tcp and tls 443 relay urls, got %v", urls)
	}
	if servers[1].Username != "minted-user" || servers[1].Credential != "minted-secret" {
		t.Fatalf("minted credentials must reach the client payload: %+v", servers[1])
	}
}

func TestCreateJoinCarriesIceServersAlongsideStun(t *testing.T) {
	fake := &fakeTurnAPI{status: http.StatusCreated}
	adapter := turnAdapter(t, fake, "key-id", "turn-api-token")

	join, err := adapter.ResumeJoin(context.Background(), mediaplane.ResumeJoinInput{Provider: mediaplane.ProviderCloudflareSFU, Episode: mediaplane.Episode{Ref: "episode"}, ExternalParticipantID: "p", ConnectionRef: "conn"})
	if err != nil {
		t.Fatal(err)
	}
	if join.ClientPayload["stunServer"] != stunServer {
		t.Fatal("stunServer must stay in the payload for older clients")
	}
	servers, ok := join.ClientPayload["iceServers"].([]mediaplane.ICEServer)
	if !ok || len(turnURLs(servers)) == 0 {
		t.Fatalf("join payload must carry TURN ice servers: %+v", join.ClientPayload["iceServers"])
	}
}

func TestIceServersAreStunOnlyWithoutTurnKey(t *testing.T) {
	fake := &fakeTurnAPI{status: http.StatusCreated}
	adapter := turnAdapter(t, fake, "", "")

	servers := adapter.iceServers(context.Background())

	if len(servers) != 1 || servers[0].URLs[0] != stunServer || servers[0].Username != "" {
		t.Fatalf("expected the STUN fallback, got %+v", servers)
	}
	if fake.requests.Load() != 0 {
		t.Fatal("no TURN key means no Cloudflare call")
	}
}

func TestIceServersFallBackToStunWhenMintFailsAndBackOff(t *testing.T) {
	fake := &fakeTurnAPI{status: http.StatusInternalServerError}
	adapter := turnAdapter(t, fake, "key-id", "turn-api-token")

	for range 3 {
		servers := adapter.iceServers(context.Background())
		if len(servers) != 1 || servers[0].Username != "" {
			t.Fatalf("a failed mint must degrade to STUN, got %+v", servers)
		}
	}
	if fake.requests.Load() != 1 {
		t.Fatalf("joins must not hammer a failing Cloudflare API, got %d requests", fake.requests.Load())
	}
}

func TestIceServersReuseMintedCredentials(t *testing.T) {
	fake := &fakeTurnAPI{status: http.StatusCreated}
	adapter := turnAdapter(t, fake, "key-id", "turn-api-token")

	adapter.iceServers(context.Background())
	adapter.iceServers(context.Background())
	if fake.requests.Load() != 1 {
		t.Fatalf("expected one mint for two joins, got %d", fake.requests.Load())
	}

	adapter.turn.mintedAt = time.Now().Add(-turnCredentialReuse - time.Second)
	adapter.iceServers(context.Background())
	if fake.requests.Load() != 2 {
		t.Fatalf("expected a fresh mint after the reuse window, got %d", fake.requests.Load())
	}
}

func TestIceServersRejectResponseWithoutTurnServer(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"iceServers":[{"urls":["stun:stun.cloudflare.com:3478"]}]}`))
	}))
	defer server.Close()
	adapter, err := NewAdapterWithClient(config.CloudflareRealtimeConfig{RealtimeAppID: "a", RealtimeAppSecret: "s", TurnKeyID: "k", TurnAPIToken: "t", RequestTimeout: time.Second}, server.Client(), server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if servers := adapter.iceServers(context.Background()); len(turnURLs(servers)) != 0 {
		t.Fatalf("a response with no TURN credentials must fall back, got %+v", servers)
	}
}

func TestTurnReuseWindowLeavesALongCallMargin(t *testing.T) {
	const longestCall = 8 * time.Hour
	if remaining := turnCredentialTTL - turnCredentialReuse; remaining < longestCall {
		t.Fatalf("a reused credential keeps only %s of life, want at least %s", remaining, longestCall)
	}
}
