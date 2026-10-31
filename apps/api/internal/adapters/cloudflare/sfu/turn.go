package sfu

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

const (
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

// TurnCredentials mints and caches Cloudflare TURN credentials for the
// deployment's TURN key. The key is global, so one TurnCredentials serves every
// adapter built for the deployment and its cache and failure backoff outlive a
// single media-plane resolution. A mint failure never fails a join: clients
// fall back to STUN, and a join waits at most turnMintTimeout for a mint.
type TurnCredentials struct {
	keyID    string
	apiToken string

	mu       sync.Mutex
	servers  []mediaplane.ICEServer
	mintedAt time.Time
	failedAt time.Time
	lastErr  error
	inflight chan struct{}
}

// NewTurnCredentials returns nil when the key or token is blank.
func NewTurnCredentials(keyID, apiToken string) *TurnCredentials {
	keyID, apiToken = strings.TrimSpace(keyID), strings.TrimSpace(apiToken)
	if keyID == "" || apiToken == "" {
		return nil
	}
	return &TurnCredentials{keyID: keyID, apiToken: apiToken}
}

// WithTurnCredentials returns the adapter using a shared TURN minter.
func (a Adapter) WithTurnCredentials(turn *TurnCredentials) Adapter {
	a.turn = turn
	return a
}

// iceServers returns the ICE servers a client should use: Cloudflare STUN and,
// when the caller allows relay and a TURN key is configured and reachable,
// Cloudflare TURN. Everyone else gets STUN alone.
func (a Adapter) iceServers(ctx context.Context, allowRelay bool) []mediaplane.ICEServer {
	fallback := []mediaplane.ICEServer{{URLs: []string{stunServer}}}
	if !allowRelay || a.turn == nil {
		return fallback
	}
	servers, err := a.turn.get(ctx, a.client, a.endpoint)
	if err != nil {
		slog.WarnContext(ctx, "Cloudflare TURN credentials unavailable; clients use STUN only",
			"event", "cloudflare_turn.credentials_failed",
			"error", err.Error(),
		)
		return fallback
	}
	return servers
}

func (t *TurnCredentials) get(ctx context.Context, client httpClient, endpoint string) ([]mediaplane.ICEServer, error) {
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

func (t *TurnCredentials) mintAndStore(ctx context.Context, client httpClient, endpoint string, done chan struct{}) {
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

func (t *TurnCredentials) mint(ctx context.Context, client httpClient, endpoint string) ([]mediaplane.ICEServer, error) {
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
