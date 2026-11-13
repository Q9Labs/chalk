package recordernodebootstrap

import (
	"bytes"
	"context"
	"crypto"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderbootstrapprotocol"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

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
