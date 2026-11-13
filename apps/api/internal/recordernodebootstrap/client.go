package recordernodebootstrap

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderbootstrapprotocol"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

const maximumResponseBytes = 1 << 20

var ErrBootstrapUnavailable = errors.New("recorder node bootstrap unavailable")

type Client struct {
	baseURL    *url.URL
	httpClient *http.Client
	now        func() time.Time
}

func NewClient(config Config) (*Client, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	caPEM, err := os.ReadFile(config.BootstrapCAFile)
	if err != nil {
		return nil, fmt.Errorf("%w: read bootstrap ca", ErrInvalidConfig)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		return nil, fmt.Errorf("%w: bootstrap ca contains no certificates", ErrInvalidConfig)
	}
	baseURL, _ := url.Parse(config.BootstrapEndpoint)
	transport := &http.Transport{
		TLSClientConfig:   &tls.Config{RootCAs: roots, ServerName: config.BootstrapServerName, MinVersion: tls.VersionTLS13},
		ForceAttemptHTTP2: true, MaxIdleConns: 2, MaxIdleConnsPerHost: 2, IdleConnTimeout: time.Minute,
		DialContext: (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
	}
	return &Client{baseURL: baseURL, httpClient: &http.Client{
		Transport: transport, Timeout: 30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}, now: time.Now}, nil
}

type Claims struct {
	ProviderID     string
	ReleaseID      string
	ImageDigest    string
	BootGeneration uint64
}

func (client *Client) bootstrap(ctx context.Context, claims Claims, csrPEM string, privateKey ed25519.PrivateKey, attempt int) (recorderbootstrapprotocol.BootstrapResponse, error) {
	challengeRequest := recorderbootstrapprotocol.ChallengeRequest{
		SchemaVersion: recorderbootstrapprotocol.ChallengeSchemaVersion, ProviderID: claims.ProviderID,
		ReleaseID: claims.ReleaseID, ImageDigest: claims.ImageDigest, BootGeneration: claims.BootGeneration, CSRPEM: csrPEM,
	}
	if err := challengeRequest.Validate(); err != nil || len(privateKey) != ed25519.PrivateKeySize {
		return recorderbootstrapprotocol.BootstrapResponse{}, ErrInvalidConfig
	}
	var challenge recorderbootstrapprotocol.ChallengeResponse
	logStep("challenge", attempt, "started", 0, nil)
	if err := client.doJSON(ctx, recorderbootstrapprotocol.ChallengePath, nil, challengeRequest, &challenge); err != nil {
		logStep("challenge", attempt, reasonCode(err, "challenge_unavailable"), httpStatus(err), err)
		return recorderbootstrapprotocol.BootstrapResponse{}, stepError{step: "challenge", err: err}
	}
	if challenge.SchemaVersion != recorderbootstrapprotocol.ChallengeSchemaVersion || challenge.ExpiresAt.Before(client.now().Add(time.Second)) {
		logStep("challenge", attempt, "invalid_response", 0, ErrBootstrapUnavailable)
		return recorderbootstrapprotocol.BootstrapResponse{}, stepError{step: "challenge", err: ErrBootstrapUnavailable}
	}
	if _, err := recorderbootstrapprotocol.DecodeNonce(challenge.Nonce); err != nil {
		logStep("challenge", attempt, "invalid_response", 0, ErrBootstrapUnavailable)
		return recorderbootstrapprotocol.BootstrapResponse{}, stepError{step: "challenge", err: ErrBootstrapUnavailable}
	}
	logStep("challenge", attempt, "completed", http.StatusOK, nil)
	request := recorderbootstrapprotocol.BootstrapRequest{
		SchemaVersion: recorderbootstrapprotocol.BootstrapSchemaVersion, ProviderID: claims.ProviderID,
		ReleaseID: claims.ReleaseID, ImageDigest: claims.ImageDigest, BootGeneration: claims.BootGeneration, CSRPEM: csrPEM,
		Nonce: challenge.Nonce, ExpiresAt: challenge.ExpiresAt, InventoryDigest: challenge.InventoryDigest,
	}
	proof, err := recorderbootstrapprotocol.CanonicalBootstrapProof(request)
	if err != nil {
		return recorderbootstrapprotocol.BootstrapResponse{}, ErrInvalidConfig
	}
	request.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(privateKey, proof))
	if err := request.Validate(); err != nil {
		return recorderbootstrapprotocol.BootstrapResponse{}, ErrInvalidConfig
	}
	var response recorderbootstrapprotocol.BootstrapResponse
	logStep("certificate", attempt, "started", 0, nil)
	if err := client.doJSON(ctx, recorderbootstrapprotocol.BootstrapPath, nil, request, &response); err != nil {
		logStep("certificate", attempt, reasonCode(err, "certificate_unavailable"), httpStatus(err), err)
		return recorderbootstrapprotocol.BootstrapResponse{}, stepError{step: "certificate", err: err}
	}
	logStep("certificate", attempt, "completed", http.StatusOK, nil)
	return response, nil
}

func (client *Client) reportDiagnostic(ctx context.Context, claims Claims, csrPEM string, privateKey ed25519.PrivateKey, diagnostic recorderfleet.BootstrapDiagnostic) error {
	request := recorderbootstrapprotocol.DiagnosticRequest{
		SchemaVersion: recorderbootstrapprotocol.DiagnosticSchemaVersion, ProviderID: claims.ProviderID,
		ReleaseID: claims.ReleaseID, ImageDigest: claims.ImageDigest, BootGeneration: claims.BootGeneration,
		CSRPEM: csrPEM, Diagnostic: diagnostic,
	}
	proof, err := recorderbootstrapprotocol.CanonicalDiagnosticProof(request)
	if err != nil {
		return ErrInvalidConfig
	}
	request.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(privateKey, proof))
	return client.doNoContent(ctx, recorderbootstrapprotocol.DiagnosticPath, request)
}

func (client *Client) Renew(ctx context.Context, endpoint string, certificateFile, privateKeyFile string, request recorderbootstrapprotocol.RenewRequest) (recorderbootstrapprotocol.RenewResponse, error) {
	if request.Validate() != nil {
		return recorderbootstrapprotocol.RenewResponse{}, ErrInvalidConfig
	}
	certificate, err := tls.LoadX509KeyPair(certificateFile, privateKeyFile)
	if err != nil {
		return recorderbootstrapprotocol.RenewResponse{}, fmt.Errorf("%w: load current worker identity", ErrInvalidConfig)
	}
	endpointURL, err := url.Parse(endpoint)
	if err != nil || endpointURL.Scheme != "https" || endpointURL.Host == "" || endpointURL.User != nil || endpointURL.RawQuery != "" || endpointURL.Fragment != "" {
		return recorderbootstrapprotocol.RenewResponse{}, fmt.Errorf("%w: renewal endpoint", ErrInvalidConfig)
	}
	tlsConfig := client.httpClient.Transport.(*http.Transport).TLSClientConfig.Clone()
	tlsConfig.Certificates = []tls.Certificate{certificate}
	transport := client.httpClient.Transport.(*http.Transport).Clone()
	transport.TLSClientConfig = tlsConfig
	renewalClient := &http.Client{Transport: transport, Timeout: 30 * time.Second, CheckRedirect: client.httpClient.CheckRedirect}
	var response recorderbootstrapprotocol.RenewResponse
	if err := client.doJSON(ctx, "", renewalClient, request, &response, endpointURL); err != nil {
		return recorderbootstrapprotocol.RenewResponse{}, err
	}
	return response, nil
}

func (client *Client) doJSON(ctx context.Context, path string, alternate *http.Client, input, output any, explicitEndpoint ...*url.URL) error {
	encoded, err := json.Marshal(input)
	if err != nil {
		return ErrInvalidConfig
	}
	endpoint := client.baseURL.ResolveReference(&url.URL{Path: path})
	if len(explicitEndpoint) == 1 {
		endpoint = explicitEndpoint[0]
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(encoded))
	if err != nil {
		return ErrInvalidConfig
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	httpClient := client.httpClient
	if alternate != nil {
		httpClient = alternate
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("%w: request: %w", ErrBootstrapUnavailable, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maximumResponseBytes))
		return fmt.Errorf("%w: %w", ErrBootstrapUnavailable, responseError{status: response.StatusCode})
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, maximumResponseBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return fmt.Errorf("%w: invalid response", ErrBootstrapUnavailable)
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return fmt.Errorf("%w: trailing response", ErrBootstrapUnavailable)
	}
	return nil
}

func (client *Client) doNoContent(ctx context.Context, path string, input any) error {
	encoded, err := json.Marshal(input)
	if err != nil {
		return ErrInvalidConfig
	}
	endpoint := client.baseURL.ResolveReference(&url.URL{Path: path})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(encoded))
	if err != nil {
		return ErrInvalidConfig
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	response, err := client.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("%w: diagnostic request", ErrBootstrapUnavailable)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maximumResponseBytes))
	if response.StatusCode != http.StatusNoContent {
		return fmt.Errorf("%w: %w", ErrBootstrapUnavailable, responseError{status: response.StatusCode})
	}
	return nil
}
