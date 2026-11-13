package chalksfu_test

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func (s *sfu) httpClient(t *testing.T, clientCA *authority, identity string) *http.Client {
	t.Helper()
	certPEM, keyPEM := clientCA.issue(t, identity, x509.ExtKeyUsageClientAuth)
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(s.ca.cert)
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: pool, ServerName: "localhost", Certificates: []tls.Certificate{pair}}}
	t.Cleanup(transport.CloseIdleConnections)
	return &http.Client{Transport: transport, Timeout: 10 * time.Second}
}

// adapter builds the API's adapter against this service with a client certificate
// from clientCA that names identity.
func (s *sfu) adapter(t *testing.T, clientCA *authority, identity string) *chalksfu.Adapter {
	t.Helper()
	return s.adapterTo(t, clientCA, identity, s.controlURL)
}

// adapterAt points the right client identity at another URL, such as a proxy.
func (s *sfu) adapterAt(t *testing.T, url string) *chalksfu.Adapter {
	t.Helper()
	return s.adapterTo(t, s.ca, clientIdentity, url)
}

func (s *sfu) adapterTo(t *testing.T, clientCA *authority, identity, controlURL string) *chalksfu.Adapter {
	t.Helper()
	fleet := s.fleetOf(t, clientCA, identity, runtimeconfig.ChalkSFUNode{ID: "sfu-a", ControlURL: controlURL})
	adapter, err := fleet.Node("sfu-a")
	if err != nil {
		t.Fatal(err)
	}
	return adapter
}

// fleet is a one-node pool on this service with the right client identity.
func (s *sfu) fleet(t *testing.T) *chalksfu.Fleet {
	t.Helper()
	return s.fleetOf(t, s.ca, clientIdentity, runtimeconfig.ChalkSFUNode{ID: "sfu-a", ControlURL: s.controlURL})
}

// fleetOf builds a pool trusting this service's CA with a client certificate
// from clientCA that names identity.
func (s *sfu) fleetOf(t *testing.T, clientCA *authority, identity string, nodes ...runtimeconfig.ChalkSFUNode) *chalksfu.Fleet {
	t.Helper()
	return s.buildFleet(t, nil, clientCA, identity, true, nodes...)
}

// loggedFleetOf is fleetOf with a logger, for tests that read the pool's transitions.
func (s *sfu) loggedFleetOf(t *testing.T, log *slog.Logger, clientCA *authority, identity string, nodes ...runtimeconfig.ChalkSFUNode) *chalksfu.Fleet {
	t.Helper()
	return s.buildFleet(t, log, clientCA, identity, true, nodes...)
}

// fleetWithOverflow is fleetOf with the Cloudflare overflow switch set.
func (s *sfu) fleetWithOverflow(t *testing.T, clientCA *authority, identity string, overflow bool, nodes ...runtimeconfig.ChalkSFUNode) *chalksfu.Fleet {
	t.Helper()
	return s.buildFleet(t, nil, clientCA, identity, overflow, nodes...)
}

func (s *sfu) buildFleet(t *testing.T, log *slog.Logger, clientCA *authority, identity string, overflow bool, nodes ...runtimeconfig.ChalkSFUNode) *chalksfu.Fleet {
	t.Helper()
	certPEM, keyPEM := clientCA.issue(t, identity, x509.ExtKeyUsageClientAuth)
	fleet, err := chalksfu.NewFleet(runtimeconfig.ChalkSFUConfig{
		Enabled: true, ApplicationID: "conformance-pool", CloudflareOverflow: overflow, Nodes: nodes, ServerName: "localhost", STUNURLs: []string{"stun:stun.example:3478"},
		CAFile: write(t, s.dir, "trust.pem", s.ca.pem), ClientCertFile: write(t, s.dir, fmt.Sprintf("client-%d.pem", serial.Add(1)), certPEM),
		ClientKeyFile: write(t, s.dir, fmt.Sprintf("client-%d.key", serial.Load()), keyPEM), RequestTimeout: 10 * time.Second, StandbyPacketBudget: 16000,
	}, log)
	if err != nil {
		t.Fatalf("new fleet: %v", err)
	}
	return fleet
}

// grant grants every source of each Participant at revision 1, as Sync does when it
// lets them publish.
func (s *sfu) grant(t *testing.T, scopes ...mediaplane.Scope) {
	t.Helper()
	adapter := s.adapterAt(t, s.controlURL)
	for _, scope := range scopes {
		var controls []mediaplane.SourceControl
		for _, source := range mediaplane.AllSources {
			controls = append(controls, mediaplane.SourceControl{ParticipantID: scope.ParticipantID, Source: source, Action: mediaplane.SourceGrant, Revision: 1})
		}
		if _, err := adapter.ControlSources(context.Background(), mediaplane.ControlSourcesInput{TenantID: scope.TenantID, EpisodeID: scope.EpisodeID, Controls: controls}); err != nil {
			t.Fatalf("grant %s: %v", scope.ParticipantID, err)
		}
	}
}

func (s *sfu) service(t *testing.T) mediaplane.Service {
	t.Helper()
	return mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, s.adapter(t, s.ca, clientIdentity))
}
