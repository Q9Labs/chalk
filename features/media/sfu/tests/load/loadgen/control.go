package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// controlClient speaks the SFU's mutual-TLS control API.
type controlClient struct {
	base string
	http *http.Client
}

func newControlClient(base, serverName, caFile, certFile, keyFile string) (*controlClient, error) {
	authority, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("read CA: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(authority) {
		return nil, fmt.Errorf("CA file %s holds no certificate", caFile)
	}
	pair, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("load client certificate: %w", err)
	}
	transport := &http.Transport{
		TLSClientConfig:     &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: pool, Certificates: []tls.Certificate{pair}, ServerName: serverName},
		MaxIdleConnsPerHost: 64,
		IdleConnTimeout:     time.Minute,
	}
	return &controlClient{base: base, http: &http.Client{Transport: transport, Timeout: 30 * time.Second}}, nil
}

// apiError is a non-2xx answer from the control API.
type apiError struct {
	path   string
	status int
	code   string
}

func (e *apiError) Error() string {
	return fmt.Sprintf("POST %s: status %d code %q", e.path, e.status, e.code)
}

func (c *controlClient) post(ctx context.Context, path string, body, out any) error {
	encoded, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("encode %s: %w", path, err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("POST %s: %w", path, err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	if response.StatusCode >= 300 {
		var problem protocol.ErrorResponse
		_ = json.Unmarshal(raw, &problem)
		return &apiError{path: path, status: response.StatusCode, code: problem.Error.Code}
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("decode %s: %w", path, err)
		}
	}
	return nil
}

func (c *controlClient) closeIdle() { c.http.CloseIdleConnections() }
