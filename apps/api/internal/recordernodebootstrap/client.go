package recordernodebootstrap

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderbootstrapprotocol"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
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

func (client *Client) Bootstrap(ctx context.Context, claims Claims, csrPEM string, privateKey ed25519.PrivateKey) (recorderbootstrapprotocol.BootstrapResponse, error) {
	challengeRequest := recorderbootstrapprotocol.ChallengeRequest{
		SchemaVersion: recorderbootstrapprotocol.ChallengeSchemaVersion, ProviderID: claims.ProviderID,
		ReleaseID: claims.ReleaseID, ImageDigest: claims.ImageDigest, BootGeneration: claims.BootGeneration, CSRPEM: csrPEM,
	}
	if err := challengeRequest.Validate(); err != nil || len(privateKey) != ed25519.PrivateKeySize {
		return recorderbootstrapprotocol.BootstrapResponse{}, ErrInvalidConfig
	}
	var challenge recorderbootstrapprotocol.ChallengeResponse
	if err := client.doJSON(ctx, recorderbootstrapprotocol.ChallengePath, nil, challengeRequest, &challenge); err != nil {
		return recorderbootstrapprotocol.BootstrapResponse{}, err
	}
	if challenge.SchemaVersion != recorderbootstrapprotocol.ChallengeSchemaVersion || challenge.ExpiresAt.Before(client.now().Add(time.Second)) {
		return recorderbootstrapprotocol.BootstrapResponse{}, ErrBootstrapUnavailable
	}
	if _, err := recorderbootstrapprotocol.DecodeNonce(challenge.Nonce); err != nil {
		return recorderbootstrapprotocol.BootstrapResponse{}, ErrBootstrapUnavailable
	}
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
	if err := client.doJSON(ctx, recorderbootstrapprotocol.BootstrapPath, nil, request, &response); err != nil {
		return recorderbootstrapprotocol.BootstrapResponse{}, err
	}
	return response, nil
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
		return fmt.Errorf("%w: request", ErrBootstrapUnavailable)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maximumResponseBytes))
		return fmt.Errorf("%w: status %d", ErrBootstrapUnavailable, response.StatusCode)
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

func ValidateBootstrapResponse(config Config, claims Claims, csrPEM string, response recorderbootstrapprotocol.BootstrapResponse, now time.Time) error {
	if response.SchemaVersion != recorderbootstrapprotocol.BootstrapSchemaVersion || response.Identity.ProviderID != claims.ProviderID || response.Identity.Role != config.Role || response.Identity.BootGeneration != claims.BootGeneration {
		return ErrBootstrapUnavailable
	}
	if id, err := utilities.ParseID(response.Identity.WorkerID); err != nil || id.IsZero() {
		return ErrBootstrapUnavailable
	}
	if response.CertificateExpiresAt.Before(now.Add(time.Minute)) || !validHTTPSURL(response.ControlPlaneURL) || !validHTTPSURL(response.RenewalEndpoint) || !validHTTPSURL(response.ClientCRLEndpoint) || !validServerName(response.ControlPlaneServerName) {
		return ErrBootstrapUnavailable
	}
	csr, _, err := recorderbootstrapprotocol.ParseCSR(csrPEM)
	if err != nil {
		return ErrBootstrapUnavailable
	}
	leaf, err := validateClientCertificate(response.ClientCertificatePEM, response.ClientCAChainPEM, csr.PublicKey, now)
	if err != nil || leaf.NotAfter.Sub(response.CertificateExpiresAt) > time.Second || response.CertificateExpiresAt.Sub(leaf.NotAfter) > time.Second {
		return ErrBootstrapUnavailable
	}
	if !containsCertificate(response.ControlPlaneServerCAPEM) {
		return ErrBootstrapUnavailable
	}
	return nil
}

func ValidateRenewResponse(csrPEM string, response recorderbootstrapprotocol.RenewResponse, now time.Time) error {
	if response.SchemaVersion != recorderbootstrapprotocol.RenewSchemaVersion || response.CertificateExpiresAt.Before(now.Add(time.Minute)) {
		return ErrBootstrapUnavailable
	}
	csr, _, err := recorderbootstrapprotocol.ParseCSR(csrPEM)
	if err != nil {
		return ErrBootstrapUnavailable
	}
	leaf, err := validateClientCertificate(response.ClientCertificatePEM, response.ClientCAChainPEM, csr.PublicKey, now)
	if err != nil || leaf.NotAfter.Sub(response.CertificateExpiresAt) > time.Second || response.CertificateExpiresAt.Sub(leaf.NotAfter) > time.Second {
		return ErrBootstrapUnavailable
	}
	return nil
}

func validateClientCertificate(certificatePEM, caPEM string, publicKey any, now time.Time) (*x509.Certificate, error) {
	certificates, err := parseCertificates(certificatePEM)
	if err != nil || len(certificates) == 0 {
		return nil, ErrBootstrapUnavailable
	}
	leafPublicKey, ok := certificates[0].PublicKey.(interface{ Equal(crypto.PublicKey) bool })
	if !ok || !leafPublicKey.Equal(publicKey) {
		return nil, ErrBootstrapUnavailable
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM([]byte(caPEM)) {
		return nil, ErrBootstrapUnavailable
	}
	intermediates := x509.NewCertPool()
	for _, certificate := range certificates[1:] {
		intermediates.AddCert(certificate)
	}
	if _, err := certificates[0].Verify(x509.VerifyOptions{Roots: roots, Intermediates: intermediates, CurrentTime: now, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err != nil {
		return nil, ErrBootstrapUnavailable
	}
	return certificates[0], nil
}

func parseCertificates(value string) ([]*x509.Certificate, error) {
	data := []byte(value)
	result := make([]*x509.Certificate, 0, 2)
	for len(bytes.TrimSpace(data)) > 0 {
		block, rest := pem.Decode(data)
		if block == nil || block.Type != "CERTIFICATE" {
			return nil, ErrBootstrapUnavailable
		}
		certificate, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return nil, ErrBootstrapUnavailable
		}
		result = append(result, certificate)
		data = rest
	}
	return result, nil
}

func containsCertificate(value string) bool {
	certificates, err := parseCertificates(value)
	return err == nil && len(certificates) > 0
}

func validHTTPSURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.Scheme == "https" && parsed.Host != "" && parsed.User == nil && parsed.RawQuery == "" && parsed.Fragment == ""
}

func ProviderID(ctx context.Context, metadataURL string) (string, error) {
	parsed, err := url.Parse(metadataURL)
	if err != nil || parsed.Scheme != "http" || parsed.Host != "169.254.169.254" || parsed.Path != "/metadata/v1/id" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", ErrInvalidConfig
	}
	client := &http.Client{
		Transport: &http.Transport{DialContext: (&net.Dialer{Timeout: 2 * time.Second}).DialContext}, Timeout: 3 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	response, err := client.Do(request)
	if err != nil {
		return "", fmt.Errorf("%w: metadata request", ErrBootstrapUnavailable)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%w: metadata status %d", ErrBootstrapUnavailable, response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 129))
	value := strings.TrimSpace(string(data))
	id, parseErr := strconv.ParseInt(value, 10, 64)
	if err != nil || parseErr != nil || id <= 0 || strconv.FormatInt(id, 10) != value {
		return "", fmt.Errorf("%w: invalid metadata id", ErrBootstrapUnavailable)
	}
	return value, nil
}
