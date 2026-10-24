// This fixture runs the real private API bridge and database-backed executor.
// Only the external Cloudflare endpoint is faked.
package main

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/providerbridge"
	"github.com/q9labs/chalk/apps/api/internal/syncidentity"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type episode struct{ Tenant, Episode, Participant string }

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	// EOF on the owning BEAM's port or this deadline stops all owned servers.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	scanner := bufio.NewScanner(os.Stdin)
	if !scanner.Scan() {
		return fmt.Errorf("missing fixture input")
	}
	var episodes []episode
	if err := json.Unmarshal(scanner.Bytes(), &episodes); err != nil {
		return err
	}
	go func() {
		for scanner.Scan() {
		}
		cancel()
	}()
	pool, err := pgxpool.New(ctx, os.Getenv("CHALK_DATABASE_URL"))
	if err != nil {
		return err
	}
	defer pool.Close()
	repository := postgres.NewProviderOperationRepositoryWithPool(pool)
	publications := mediapublications.NewService(repository)
	for _, fixture := range episodes {
		tenant, err := utilities.ParseID(fixture.Tenant)
		if err != nil {
			return err
		}
		episodeID, err := utilities.ParseID(fixture.Episode)
		if err != nil {
			return err
		}
		participant, err := utilities.ParseID(fixture.Participant)
		if err != nil {
			return err
		}
		_, err = pool.Exec(ctx, `update participants set media_connection_id = 'closed-session', media_connection_generation = generation where id = $1`, participant.Bytes())
		if err != nil {
			return err
		}
		_, err = publications.RecordPublishedTracks(ctx, mediapublications.RecordInput{TenantID: tenant, EpisodeID: episodeID, ParticipantID: participant, ParticipantGeneration: 1, ConnectionID: "closed-session", Tracks: []mediapublications.PublishedTrack{{Source: "camera", MID: "0", TrackName: "camera"}}})
		if err != nil {
			return err
		}
	}
	release := make(chan struct{})
	entered := make(chan struct{})
	var enterOnce, releaseOnce sync.Once
	vendor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/wait":
			select {
			case <-entered:
				w.WriteHeader(204)
			case <-r.Context().Done():
			}
		case "/release":
			releaseOnce.Do(func() { close(release) })
			w.WriteHeader(204)
		default:
			if r.Method != http.MethodPut || r.URL.Path != "/apps/test-app/sessions/closed-session/tracks/close" {
				http.Error(w, "unexpected vendor request", 400)
				return
			}
			enterOnce.Do(func() { close(entered) })
			select {
			case <-release:
				w.WriteHeader(http.StatusGone)
				_, _ = w.Write([]byte(`{"errorCode":"session_error","errorDescription":"Session is gone"}`))
			case <-r.Context().Done():
			case <-ctx.Done():
			}
		}
	}))
	defer vendor.Close()
	defer releaseOnce.Do(func() { close(release) })
	adapter, err := sfu.NewAdapter(config.CloudflareRealtimeConfig{RealtimeAppID: "test-app", RealtimeAppSecret: "test-only", RealtimeBaseURL: vendor.URL, RequestTimeout: 30 * time.Second})
	if err != nil {
		return err
	}
	verifier, err := syncidentity.NewVerifier("bridge.test", "test")
	if err != nil {
		return err
	}
	bridge := httptest.NewUnstartedServer(httpapi.NewProviderBridgeHandler(providerbridge.NewService(repository, providerbridge.NewSFUExecutor(publications, adapter)), verifier))
	cert, roots, err := certificates(os.Args[1])
	if err != nil {
		return err
	}
	bridge.TLS = &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{cert}, ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: roots}
	bridge.StartTLS()
	defer bridge.Close()
	if err := json.NewEncoder(os.Stdout).Encode(map[string]string{"base_url": bridge.URL, "control_url": vendor.URL}); err != nil {
		return err
	}
	<-ctx.Done()
	return nil
}

func certificates(directory string) (tls.Certificate, *x509.CertPool, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	identity, _ := url.Parse("spiffe://bridge.test/environment/test/sync/11111111-1111-4111-8111-111111111111")
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "bridge.test"}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, URIs: []*url.URL{identity}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	for name, data := range map[string][]byte{"cert.pem": certPEM, "key.pem": keyPEM} {
		if err := os.WriteFile(filepath.Join(directory, name), data, 0600); err != nil {
			return tls.Certificate{}, nil, err
		}
	}
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(certPEM)
	return cert, roots, nil
}
