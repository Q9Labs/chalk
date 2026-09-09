package recorderbootstrapprotocol

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

const (
	ControllerBootstrapSchemaVersion = "recorder_fleet_issuer_bootstrap.v1"
	ControllerAbandonSchemaVersion   = "recorder_fleet_issuer_abandon.v1"
	ControllerRevokeSchemaVersion    = "recorder_fleet_issuer_revoke.v1"
	ChallengeSchemaVersion           = "recorder_fleet_node_bootstrap_challenge.v1"
	BootstrapSchemaVersion           = "recorder_fleet_node_bootstrap.v1"
	RenewSchemaVersion               = "recorder_fleet_node_renew.v1"

	ChallengePath           = "/v1/recorder-fleet/node-bootstrap/challenge"
	BootstrapPath           = "/v1/recorder-fleet/node-bootstrap"
	RenewPath               = "/v1/recorder-fleet/node-renew"
	ControllerBootstrapPath = "/v1/recorder-fleet/bootstrap"
	ControllerAbandonPath   = "/v1/recorder-fleet/bootstrap/abandon"
	ControllerRevokePath    = "/v1/recorder-fleet/revoke"
)

var ErrInvalidProtocol = errors.New("invalid recorder bootstrap protocol message")

type ChallengeRequest struct {
	SchemaVersion  string `json:"schema_version"`
	ProviderID     string `json:"provider_id"`
	ReleaseID      string `json:"release_id"`
	ImageDigest    string `json:"image_digest"`
	BootGeneration uint64 `json:"boot_generation"`
	CSRPEM         string `json:"csr_pem"`
}

type ChallengeResponse struct {
	SchemaVersion   string    `json:"schema_version"`
	Nonce           string    `json:"nonce"`
	ExpiresAt       time.Time `json:"expires_at"`
	InventoryDigest string    `json:"inventory_digest"`
}

type BootstrapRequest struct {
	SchemaVersion   string    `json:"schema_version"`
	ProviderID      string    `json:"provider_id"`
	ReleaseID       string    `json:"release_id"`
	ImageDigest     string    `json:"image_digest"`
	BootGeneration  uint64    `json:"boot_generation"`
	CSRPEM          string    `json:"csr_pem"`
	Nonce           string    `json:"nonce"`
	ExpiresAt       time.Time `json:"expires_at"`
	InventoryDigest string    `json:"inventory_digest"`
	Signature       string    `json:"signature"`
}

type BootstrapResponse struct {
	SchemaVersion           string                     `json:"schema_version"`
	Identity                recorderfleet.NodeIdentity `json:"identity"`
	ClientCertificatePEM    string                     `json:"client_certificate_pem"`
	ClientCAChainPEM        string                     `json:"client_ca_chain_pem"`
	ControlPlaneURL         string                     `json:"control_plane_url"`
	ControlPlaneServerName  string                     `json:"control_plane_server_name"`
	ControlPlaneServerCAPEM string                     `json:"control_plane_server_ca_pem"`
	RenewalEndpoint         string                     `json:"renewal_endpoint"`
	ClientCRLEndpoint       string                     `json:"client_crl_endpoint"`
	CertificateExpiresAt    time.Time                  `json:"certificate_expires_at"`
}

type RenewRequest struct {
	SchemaVersion string `json:"schema_version"`
	CSRPEM        string `json:"csr_pem"`
}

type RenewResponse struct {
	SchemaVersion        string    `json:"schema_version"`
	ClientCertificatePEM string    `json:"client_certificate_pem"`
	ClientCAChainPEM     string    `json:"client_ca_chain_pem"`
	CertificateExpiresAt time.Time `json:"certificate_expires_at"`
}

func (request ChallengeRequest) Validate() error {
	if request.SchemaVersion != ChallengeSchemaVersion || !validClaim(request.ProviderID, 128) || !validClaim(request.ReleaseID, 128) || !validDigest(request.ImageDigest) || request.BootGeneration == 0 {
		return ErrInvalidProtocol
	}
	_, _, err := ParseCSR(request.CSRPEM)
	return err
}

func (request BootstrapRequest) Validate() error {
	challenge := ChallengeRequest{
		SchemaVersion: ChallengeSchemaVersion, ProviderID: request.ProviderID,
		ReleaseID: request.ReleaseID, ImageDigest: request.ImageDigest,
		BootGeneration: request.BootGeneration, CSRPEM: request.CSRPEM,
	}
	if request.SchemaVersion != BootstrapSchemaVersion || challenge.Validate() != nil || request.ExpiresAt.IsZero() || !validInventoryDigest(request.InventoryDigest) {
		return ErrInvalidProtocol
	}
	if decoded, err := base64.RawURLEncoding.DecodeString(request.Nonce); err != nil || len(decoded) != 32 {
		return ErrInvalidProtocol
	}
	if decoded, err := base64.RawURLEncoding.DecodeString(request.Signature); err != nil || len(decoded) != ed25519.SignatureSize {
		return ErrInvalidProtocol
	}
	return nil
}

func (request RenewRequest) Validate() error {
	if request.SchemaVersion != RenewSchemaVersion {
		return ErrInvalidProtocol
	}
	_, _, err := ParseCSR(request.CSRPEM)
	return err
}

func ParseCSR(csrPEM string) (*x509.CertificateRequest, ed25519.PublicKey, error) {
	if len(csrPEM) == 0 || len(csrPEM) > 16<<10 {
		return nil, nil, ErrInvalidProtocol
	}
	block, rest := pem.Decode([]byte(csrPEM))
	if block == nil || block.Type != "CERTIFICATE REQUEST" || len(strings.TrimSpace(string(rest))) != 0 {
		return nil, nil, ErrInvalidProtocol
	}
	request, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil || request.CheckSignature() != nil {
		return nil, nil, ErrInvalidProtocol
	}
	publicKey, ok := request.PublicKey.(ed25519.PublicKey)
	if !ok || len(publicKey) != ed25519.PublicKeySize {
		return nil, nil, ErrInvalidProtocol
	}
	return request, publicKey, nil
}

func CanonicalBootstrapProof(request BootstrapRequest) ([]byte, error) {
	csr, _, err := ParseCSR(request.CSRPEM)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(csr.Raw)
	lines := []string{
		"chalk.recorder_fleet.node_bootstrap.v1",
		"provider_id=" + request.ProviderID,
		"release_id=" + request.ReleaseID,
		"image_digest=" + request.ImageDigest,
		"boot_generation=" + strconv.FormatUint(request.BootGeneration, 10),
		"inventory_digest=" + request.InventoryDigest,
		"csr_sha256=" + hex.EncodeToString(digest[:]),
		"nonce=" + request.Nonce,
		"expires_at=" + request.ExpiresAt.UTC().Format(time.RFC3339Nano),
	}
	return []byte(strings.Join(lines, "\n") + "\n"), nil
}

func VerifyBootstrapProof(request BootstrapRequest) error {
	if err := request.Validate(); err != nil {
		return err
	}
	message, err := CanonicalBootstrapProof(request)
	if err != nil {
		return err
	}
	_, publicKey, err := ParseCSR(request.CSRPEM)
	if err != nil {
		return err
	}
	signature, _ := base64.RawURLEncoding.DecodeString(request.Signature)
	if !ed25519.Verify(publicKey, message, signature) {
		return ErrInvalidProtocol
	}
	return nil
}

func validClaim(value string, maximum int) bool {
	return value != "" && len(value) <= maximum && strings.TrimSpace(value) == value && !strings.ContainsAny(value, "\r\n\x00=")
}

func validDigest(value string) bool {
	algorithm, digest, ok := strings.Cut(value, ":")
	if !ok || algorithm != "sha256" || len(digest) != sha256.Size*2 || strings.ToLower(digest) != digest {
		return false
	}
	_, err := hex.DecodeString(digest)
	return err == nil
}

func validInventoryDigest(value string) bool {
	if len(value) != sha256.Size*2 || strings.ToLower(value) != value {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func DecodeNonce(value string) ([]byte, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) != 32 {
		return nil, fmt.Errorf("%w: nonce", ErrInvalidProtocol)
	}
	return decoded, nil
}
