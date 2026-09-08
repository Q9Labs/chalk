package mtls

import (
	"crypto/sha256"
	"crypto/tls"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"
)

// ReloadingClientTransport creates a fresh connection pool whenever the client
// certificate file changes. In-flight requests finish on the retired pool;
// subsequent requests perform a new handshake with the renewed certificate.
type ReloadingClientTransport struct {
	certificateFile string
	tlsConfig       *tls.Config

	mutex       sync.Mutex
	fingerprint [sha256.Size]byte
	current     *http.Transport
}

func NewReloadingClientTransport(certificateFile, privateKeyFile, serverCAFile, serverName string) (*ReloadingClientTransport, error) {
	tlsConfig, err := LoadReloadingClientConfig(certificateFile, privateKeyFile, serverCAFile, serverName)
	if err != nil {
		return nil, err
	}
	fingerprint, err := certificateFingerprint(certificateFile)
	if err != nil {
		return nil, err
	}
	return &ReloadingClientTransport{
		certificateFile: certificateFile, tlsConfig: tlsConfig,
		fingerprint: fingerprint, current: recorderClientTransport(tlsConfig),
	}, nil
}

func (transport *ReloadingClientTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	fingerprint, err := certificateFingerprint(transport.certificateFile)
	if err != nil {
		return nil, err
	}
	transport.mutex.Lock()
	var retired *http.Transport
	if fingerprint != transport.fingerprint {
		retired = transport.current
		transport.current = recorderClientTransport(transport.tlsConfig)
		transport.fingerprint = fingerprint
	}
	current := transport.current
	transport.mutex.Unlock()
	if retired != nil {
		retired.CloseIdleConnections()
	}
	return current.RoundTrip(request)
}

func (transport *ReloadingClientTransport) CloseIdleConnections() {
	transport.mutex.Lock()
	current := transport.current
	transport.mutex.Unlock()
	current.CloseIdleConnections()
}

func recorderClientTransport(tlsConfig *tls.Config) *http.Transport {
	return &http.Transport{
		TLSClientConfig: tlsConfig, ForceAttemptHTTP2: true,
		MaxIdleConns: 8, MaxIdleConnsPerHost: 4, IdleConnTimeout: time.Minute,
	}
}

func certificateFingerprint(path string) ([sha256.Size]byte, error) {
	certificate, err := os.ReadFile(path)
	if err != nil {
		return [sha256.Size]byte{}, fmt.Errorf("%w: read client certificate for reload: %v", ErrInvalidConfig, err)
	}
	return sha256.Sum256(certificate), nil
}

var _ http.RoundTripper = (*ReloadingClientTransport)(nil)
