// Package turn mints Cloudflare TURN credentials. It is independent of the
// Cloudflare SFU adapter so retiring that adapter leaves TURN in place.
package turn

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

const (
	// defaultEndpoint is the Cloudflare Realtime API base the TURN key lives on.
	defaultEndpoint = "https://rtc.live.cloudflare.com/v1"

	sfuHTTP2SendPingTimeout = 5 * time.Second
	sfuHTTP2PingTimeout     = 5 * time.Second
	sfuIdleConnTimeout      = 90 * time.Second

	// A relayed call stops refreshing its allocation once its credential
	// expires (measured with a 60 second credential), so the TTL must outlast
	// the longest call.
	turnCredentialTTL = 12 * time.Hour
	// A minted credential is shared by joins for this long, so every client
	// still receives at least turnCredentialTTL minus this window.
	turnCredentialReuse = time.Hour
	turnMintTimeout     = 2 * time.Second
	turnMintBackoff     = 30 * time.Second
)

// HTTPClient is the request sender a mint uses.
type HTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

// Credentials mints and caches Cloudflare TURN credentials for the
// deployment's TURN key. The key is global, so one Credentials serves every
// adapter built for the deployment and its cache and failure backoff outlive a
// single media-plane resolution. A mint failure never fails a join: clients
// fall back to STUN, and a join waits at most turnMintTimeout for a mint.
type Credentials struct {
	keyID    string
	apiToken string

	mu       sync.Mutex
	servers  []mediaplane.ICEServer
	mintedAt time.Time
	failedAt time.Time
	lastErr  error
	inflight chan struct{}
}

// New returns nil when the key or token is blank.
func New(keyID, apiToken string) *Credentials {
	keyID, apiToken = strings.TrimSpace(keyID), strings.TrimSpace(apiToken)
	if keyID == "" || apiToken == "" {
		return nil
	}
	return &Credentials{keyID: keyID, apiToken: apiToken}
}

// RelayServers returns Cloudflare TURN for a media plane that is not
// Cloudflare's, such as Chalk's own SFU, from the same cache and backoff.
func (t *Credentials) RelayServers(ctx context.Context) ([]mediaplane.ICEServer, error) {
	return t.Servers(ctx, &http.Client{Transport: sharedTransport()}, defaultEndpoint)
}

var sharedTransport = sync.OnceValue(newTransport)

func newTransport() *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.IdleConnTimeout = sfuIdleConnTimeout
	transport.HTTP2 = &http.HTTP2Config{
		SendPingTimeout: sfuHTTP2SendPingTimeout,
		PingTimeout:     sfuHTTP2PingTimeout,
	}
	return transport
}

// Servers returns the cached TURN ICE servers, minting them through client at
// endpoint when the cache is stale. The Cloudflare SFU adapter passes its own
// client and endpoint so its joins keep their configured timeout and base URL.
func (t *Credentials) Servers(ctx context.Context, client HTTPClient, endpoint string) ([]mediaplane.ICEServer, error) {
	for {
		t.mu.Lock()
		now := time.Now()
		if t.servers != nil && now.Sub(t.mintedAt) < turnCredentialReuse {
			servers := t.servers
			t.mu.Unlock()
			return servers, nil
		}
		if !t.failedAt.IsZero() && now.Sub(t.failedAt) < turnMintBackoff {
			err := t.lastErr
			t.mu.Unlock()
			return nil, err
		}
		inflight := t.inflight
		if inflight == nil {
			inflight = make(chan struct{})
			t.inflight = inflight
			go t.mintAndStore(context.WithoutCancel(ctx), client, endpoint, inflight)
		}
		t.mu.Unlock()
		select {
		case <-inflight:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

func (t *Credentials) mintAndStore(ctx context.Context, client HTTPClient, endpoint string, done chan struct{}) {
	servers, err := t.mint(ctx, client, endpoint)
	t.mu.Lock()
	defer t.mu.Unlock()
	if err != nil {
		t.failedAt, t.lastErr = time.Now(), err
	} else {
		t.servers, t.mintedAt, t.failedAt, t.lastErr = servers, time.Now(), time.Time{}, nil
	}
	t.inflight = nil
	close(done)
}

func (t *Credentials) mint(ctx context.Context, client HTTPClient, endpoint string) ([]mediaplane.ICEServer, error) {
	ctx, cancel := context.WithTimeout(ctx, turnMintTimeout)
	defer cancel()

	body, err := json.Marshal(map[string]int64{"ttl": int64(turnCredentialTTL / time.Second)})
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("%s/turn/keys/%s/credentials/generate-ice-servers", endpoint, url.PathEscape(t.keyID)), bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build TURN credential request: %w", withoutRequestURL(err))
	}
	request.Header.Set("Authorization", "Bearer "+t.apiToken)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")

	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("request TURN credentials: %w", withoutRequestURL(err))
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, 1<<16))
	if err != nil {
		return nil, fmt.Errorf("read TURN credentials: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("TURN credential request returned status %d", response.StatusCode)
	}
	var decoded struct {
		ICEServers []mediaplane.ICEServer `json:"iceServers"`
	}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return nil, fmt.Errorf("decode TURN credentials: %w", err)
	}
	if !hasTurnServer(decoded.ICEServers) {
		return nil, fmt.Errorf("TURN credential response has no TURN server")
	}
	return decoded.ICEServers, nil
}

// withoutRequestURL unwraps a transport error to its cause, such as a timeout
// or a refused connection. The wrapper's text carries the request URL, which
// holds the private TURN key ID, and these errors are logged on every join.
func withoutRequestURL(err error) error {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return urlErr.Err
	}
	return err
}

func hasTurnServer(servers []mediaplane.ICEServer) bool {
	for _, server := range servers {
		if server.Username == "" || server.Credential == "" {
			continue
		}
		for _, u := range server.URLs {
			if strings.HasPrefix(u, "turn:") || strings.HasPrefix(u, "turns:") {
				return true
			}
		}
	}
	return false
}
