package chalksfu_test

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

const buildCommit = "0123456789abcdef0123456789abcdef01234567"

// oldNode is a node built before the API sent allocationGeneration: it forwards to a real node,
// but its /readyz carries no protocol or revision, and its strict decoder refuses a request body
// that has the field with 400 invalid_request. creates counts the create requests it refused or took.
type oldNode struct {
	url      string
	accepted atomic.Int32
	refused  atomic.Int32
	// readyGate, when set, holds every /readyz answer until it is closed, so a test can
	// keep the first readiness probe in flight.
	readyGate chan struct{}
	// current makes the node pass everything through, as a current build does, and failReady
	// makes its /readyz fail, as a lost probe does.
	current   bool
	failReady atomic.Bool
}

// posts is every request body the node received: creates, reserves and controls.
func (o *oldNode) posts() int32 { return o.accepted.Load() + o.refused.Load() }

func startOldNode(t *testing.T, ca *authority, real *sfu, readyGate chan struct{}) *oldNode {
	t.Helper()
	upstream := real.httpClient(t, real.ca, clientIdentity)
	old := &oldNode{readyGate: readyGate}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.URL.Path == "/readyz" && old.readyGate != nil {
			select {
			case <-old.readyGate:
			case <-r.Context().Done():
				return
			}
		}
		if r.URL.Path == "/readyz" && old.failReady.Load() {
			http.Error(w, "unavailable", http.StatusBadGateway)
			return
		}
		if r.Method == http.MethodPost && !old.current {
			var fields map[string]json.RawMessage
			if json.Unmarshal(body, &fields) == nil {
				if _, unknown := fields["allocationGeneration"]; unknown {
					old.refused.Add(1)
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusBadRequest)
					_, _ = w.Write([]byte(`{"error":{"code":"invalid_request","message":"json: unknown field \"allocationGeneration\""}}`))
					return
				}
			}
			old.accepted.Add(1)
		}
		forward, _ := http.NewRequestWithContext(r.Context(), r.Method, real.controlURL+r.URL.Path, bytes.NewReader(body))
		forward.Header.Set("Content-Type", "application/json")
		reply, err := upstream.Do(forward)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		defer reply.Body.Close()
		payload, _ := io.ReadAll(reply.Body)
		if r.URL.Path == "/readyz" && !old.current {
			var ready map[string]json.RawMessage
			if json.Unmarshal(payload, &ready) == nil {
				delete(ready, "protocol")
				delete(ready, "revision")
				payload, _ = json.Marshal(ready)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(reply.StatusCode)
		_, _ = w.Write(payload)
	}))
	certPEM, keyPEM := ca.issue(t, "localhost", x509.ExtKeyUsageServerAuth)
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	server.TLS = &tls.Config{Certificates: []tls.Certificate{pair}}
	server.StartTLS()
	t.Cleanup(server.Close)
	old.url = server.URL
	return old
}

// logLines collects what a Fleet logs.
type logLines struct {
	mu    sync.Mutex
	lines []string
}

func (l *logLines) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, string(p))
	return len(p), nil
}

func (l *logLines) text() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.lines, "")
}

func tryJoin(service mediaplane.Service, scope mediaplane.Scope) error {
	_, err := service.CreateJoin(context.Background(), mediaplane.CreateJoinInput{
		Provider: mediaplane.ProviderChalkSFU, Scope: scope,
		Episode:         mediaplane.Episode{Provider: mediaplane.ProviderChalkSFU, Ref: scope.EpisodeID},
		ParticipantName: scope.ParticipantID, ExternalParticipantID: scope.ParticipantID, ParticipantPreset: "contributor",
	})
	return err
}
