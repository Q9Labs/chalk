package recorderarchive

import (
	"context"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/feature/cloudfront/sign"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

// CDN signs archive links for a CloudFront distribution in front of the archive bucket.
// Downloads then leave through CloudFront (free tier) instead of S3 data transfer out.
type CDN struct {
	baseURL   *url.URL
	keyPairID string
	signer    *sign.URLSigner
}

// NewCDN builds a signer from the distribution URL, the CloudFront public key ID and the base64 of its PEM private key.
func NewCDN(baseURL, keyPairID, privateKeyBase64 string) (*CDN, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("%w: archive CDN URL must be an https origin", recorderfleet.ErrInvalidConfig)
	}
	if keyPairID == "" {
		return nil, fmt.Errorf("%w: archive CDN key pair ID", recorderfleet.ErrInvalidConfig)
	}
	pemBytes, err := base64.StdEncoding.DecodeString(privateKeyBase64)
	if err != nil {
		return nil, fmt.Errorf("%w: archive CDN private key is not base64", recorderfleet.ErrInvalidConfig)
	}
	key, err := parseRSAKey(pemBytes)
	if err != nil {
		return nil, err
	}
	return &CDN{baseURL: parsed, keyPairID: keyPairID, signer: sign.NewURLSigner(keyPairID, key)}, nil
}

// OptionalCDN accepts all three CDN settings or none and returns nil for none, so links come from S3.
// A partial set is an error because it would silently fall back to S3 and its transfer cost.
func OptionalCDN(baseURL, keyPairID, privateKeyBase64 string) (*CDN, error) {
	if baseURL == "" && keyPairID == "" && privateKeyBase64 == "" {
		return nil, nil
	}
	if baseURL == "" || keyPairID == "" || privateKeyBase64 == "" {
		return nil, fmt.Errorf("%w: archive CDN needs URL, key pair ID and private key together", recorderfleet.ErrInvalidConfig)
	}
	return NewCDN(baseURL, keyPairID, privateKeyBase64)
}

// Link returns the archive download link: a signed CloudFront link when cdn is set, otherwise a presigned S3 link.
func Link(ctx context.Context, cdn *CDN, archive recorderfleet.ArchiveSpec, startupTimeout time.Duration) (string, error) {
	if cdn != nil {
		return cdn.PresignCDN(archive, startupTimeout, time.Now())
	}
	return Presign(ctx, archive, startupTimeout)
}

// PresignCDN returns a signed CloudFront link for the archive that stays valid through the startup deadline.
func (c *CDN) PresignCDN(archive recorderfleet.ArchiveSpec, startupTimeout time.Duration, now time.Time) (string, error) {
	if err := archive.Validate(); err != nil {
		return "", err
	}
	if startupTimeout <= 0 || startupTimeout > 7*24*time.Hour-5*time.Minute {
		return "", recorderfleet.ErrInvalidConfig
	}
	link := c.baseURL.JoinPath(strings.TrimPrefix(archive.Key, "/")).String()
	signed, err := c.signer.Sign(link, now.Add(startupTimeout+5*time.Minute))
	if err != nil {
		return "", fmt.Errorf("sign recorder archive CDN link: %w", err)
	}
	return signed, nil
}

func parseRSAKey(pemBytes []byte) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, fmt.Errorf("%w: archive CDN private key is not PEM", recorderfleet.ErrInvalidConfig)
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("%w: archive CDN private key", recorderfleet.ErrInvalidConfig)
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("%w: archive CDN private key must be RSA", recorderfleet.ErrInvalidConfig)
	}
	return key, nil
}
