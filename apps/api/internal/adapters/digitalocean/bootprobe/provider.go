// Package bootprobe runs the fleet's provider path for isolated boot checks.
package bootprobe

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/aws/recorderarchive"
	"github.com/q9labs/chalk/apps/api/internal/adapters/digitalocean"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/spiffe"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

type Input struct {
	Operation           string                          `json:"operation"`
	Environment         string                          `json:"environment"`
	Role                workeridentity.Role             `json:"role"`
	OwnerTag            string                          `json:"owner_tag"`
	ProjectID           string                          `json:"project_id"`
	VPCUUID             string                          `json:"vpc_uuid"`
	SSHKeyIDs           []int64                         `json:"ssh_key_ids"`
	DiagnosticSSHKeyID  int64                           `json:"diagnostic_ssh_key_id"`
	EvidenceBootCommand []string                        `json:"evidence_boot_command"`
	Request             recorderfleet.EnsureNodeRequest `json:"request"`
	ProviderID          string                          `json:"provider_id"`
	EvidencePath        string                          `json:"evidence_path"`
	MutationDeadline    time.Time                       `json:"mutation_deadline"`
	CertificatePEM      string                          `json:"certificate_pem"`
	CAPEM               string                          `json:"ca_pem"`
	Serial              string                          `json:"serial"`
	Identity            recorderfleet.NodeIdentity      `json:"identity"`
	TrustDomain         string                          `json:"trust_domain"`
}

type Output struct {
	Node              recorderfleet.Node             `json:"node"`
	PublicIP          string                         `json:"public_ip"`
	Bootstrap         recorderfleet.BootstrapRequest `json:"bootstrap"`
	CertificateSHA256 string                         `json:"certificate_sha256,omitempty"`
	CertificateSerial string                         `json:"certificate_serial,omitempty"`
}

func Run(ctx context.Context, input Input, token string) (Output, error) {
	if input.Operation == "certificate" {
		return verifyCertificate(input)
	}
	if input.Operation == "create" && (input.MutationDeadline.IsZero() || !time.Now().Before(input.MutationDeadline) || input.DiagnosticSSHKeyID <= 0) {
		return Output{}, errors.New("cold create requires an unexpired mutation deadline and diagnostic SSH key")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	defer transport.CloseIdleConnections()
	adapter, err := digitalocean.NewRecorderFleet(digitalocean.RecorderFleetConfig{
		PresignArchive: func(ctx context.Context, archive recorderfleet.ArchiveSpec) (string, error) {
			return recorderarchive.Presign(ctx, archive, time.Until(input.MutationDeadline))
		},
		Token: token, Environment: input.Environment, Role: input.Role, OwnerTag: input.OwnerTag,
		ProjectID: input.ProjectID, VPCUUID: input.VPCUUID, SSHKeyIDs: input.SSHKeyIDs,
		HTTPClient: &http.Client{Transport: evidenceTransport{next: transport, path: input.EvidencePath, deadline: input.MutationDeadline, diagnosticSSHKeyID: input.DiagnosticSSHKeyID, evidenceBootCommand: input.EvidenceBootCommand}, Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	})
	if err != nil {
		return Output{}, err
	}
	key := recorderfleet.PoolKey{Environment: input.Environment, Role: input.Role}
	var node recorderfleet.Node
	switch input.Operation {
	case "create":
		if !strings.HasPrefix(input.Request.Name, recorderfleet.DiagnosticTag+"-") || !slices.Contains(input.Request.RequiredTags, recorderfleet.DiagnosticTag) {
			return Output{}, errors.New("diagnostic name and tag required")
		}
		node, err = adapter.EnsureNode(ctx, input.Request)
	case "inspect":
		var ip string
		inspected, address, inspectErr := adapter.InspectNode(ctx, key, input.ProviderID)
		node, ip, err = inspected, address.String(), inspectErr
		if err != nil {
			return Output{}, err
		}
		return Output{Node: node, PublicIP: ip, Bootstrap: recorderfleet.BootstrapRequest{
			Key: key, ProviderID: node.ProviderID, NodeName: node.Name, Region: node.Region,
			ReleaseID: input.Request.Release.ReleaseID, ImageDigest: input.Request.Release.ImageDigest,
			BootGeneration: node.BootGeneration, InventoryDigest: recorderfleet.InventoryDigest(node),
		}}, nil
	default:
		return Output{}, errors.New("unknown provider operation")
	}
	if err != nil {
		return Output{}, err
	}
	return Output{Node: node}, nil
}

func verifyCertificate(input Input) (Output, error) {
	block, _ := pem.Decode([]byte(input.CertificatePEM))
	if block == nil || block.Type != "CERTIFICATE" {
		return Output{}, errors.New("installed certificate missing")
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return Output{}, err
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM([]byte(input.CAPEM)) {
		return Output{}, errors.New("issuer CA missing")
	}
	if _, err := certificate.Verify(x509.VerifyOptions{Roots: roots, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err != nil {
		return Output{}, fmt.Errorf("verify installed certificate: %w", err)
	}
	expectedURI := spiffe.URI(input.TrustDomain, input.Environment, input.Identity.Role, input.Identity.WorkerID)
	if len(certificate.URIs) != 1 || certificate.URIs[0].String() != expectedURI || certificate.SerialNumber.Text(16) != input.Serial {
		return Output{}, errors.New("issuer/installed certificate identity or serial mismatch")
	}
	hash := sha256.Sum256(certificate.Raw)
	return Output{CertificateSHA256: hex.EncodeToString(hash[:]), CertificateSerial: certificate.SerialNumber.Text(16)}, nil
}
