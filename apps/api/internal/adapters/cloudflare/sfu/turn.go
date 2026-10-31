package sfu

import (
	"bytes"
	"context"
	"encoding/json"
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
	turnMintTimeout     = 3 * time.Second
	turnMintBackoff     = 30 * time.Second
)

// turnCredentials mints and caches Cloudflare TURN credentials for the
// deployment's TURN key. A mint failure never fails a join: clients fall back
// to STUN.
type turnCredentials struct {
	keyID    string
	apiToken string

	mu       sync.Mutex
	servers  []mediaplane.ICEServer
	mintedAt time.Time
	failedAt time.Time
}

func newTurnCredentials(keyID, apiToken string) *turnCredentials {
	keyID, apiToken = strings.TrimSpace(keyID), strings.TrimSpace(apiToken)
	if keyID == "" || apiToken == "" {
		return nil
	}
	return &turnCredentials{keyID: keyID, apiToken: apiToken}
}

// iceServers returns the ICE servers a client should use: Cloudflare STUN and
// TURN when a TURN key is configured and reachable, STUN alone otherwise.
func (a Adapter) iceServers(ctx context.Context) []mediaplane.ICEServer {
	fallback := []mediaplane.ICEServer{{URLs: []string{stunServer}}}
	if a.turn == nil {
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

func (t *turnCredentials) get(ctx context.Context, client httpClient, endpoint string) ([]mediaplane.ICEServer, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now()
	if t.servers != nil && now.Sub(t.mintedAt) < turnCredentialReuse {
		return t.servers, nil
	}
	if !t.failedAt.IsZero() && now.Sub(t.failedAt) < turnMintBackoff {
		return nil, fmt.Errorf("mint skipped during backoff after an earlier failure")
	}
	servers, err := t.mint(ctx, client, endpoint)
	if err != nil {
		t.failedAt = now
		return nil, err
	}
	t.servers, t.mintedAt, t.failedAt = servers, now, time.Time{}
	return servers, nil
}

func (t *turnCredentials) mint(ctx context.Context, client httpClient, endpoint string) ([]mediaplane.ICEServer, error) {
	ctx, cancel := context.WithTimeout(ctx, turnMintTimeout)
	defer cancel()

	body, err := json.Marshal(map[string]int64{"ttl": int64(turnCredentialTTL / time.Second)})
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("%s/turn/keys/%s/credentials/generate-ice-servers", endpoint, url.PathEscape(t.keyID)), bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build TURN credential request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+t.apiToken)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")

	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("request TURN credentials: %w", err)
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
