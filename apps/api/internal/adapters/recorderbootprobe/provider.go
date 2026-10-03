// Package recorderbootprobe runs the fleet's provider path for isolated boot checks.
package recorderbootprobe

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/digitalocean"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
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

type createRequest struct {
	UserData string `json:"user_data"`
}
type auditEntry struct {
	Time         time.Time       `json:"time"`
	Method       string          `json:"method"`
	Path         string          `json:"path"`
	OriginalBody json.RawMessage `json:"original_body,omitempty"`
	Body         json.RawMessage `json:"body,omitempty"`
	BodySHA256   string          `json:"body_sha256"`
	Status       int             `json:"status"`
	Response     json.RawMessage `json:"response,omitempty"`
}

type evidenceTransport struct {
	next                http.RoundTripper
	path                string
	diagnosticSSHKeyID  int64
	evidenceBootCommand []string
	deadline            time.Time
}

func addDiagnosticSSHKey(body []byte, keyID int64) ([]byte, error) {
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	var keys []int64
	if raw := payload["ssh_keys"]; raw != nil {
		if err := json.Unmarshal(raw, &keys); err != nil {
			return nil, err
		}
	}
	if keyID <= 0 || slices.Contains(keys, keyID) {
		return nil, errors.New("invalid diagnostic SSH key")
	}
	encoded, err := json.Marshal(append(keys, keyID))
	if err != nil {
		return nil, err
	}
	payload["ssh_keys"] = encoded
	return json.Marshal(payload)
}

// Preserve the actual bootstrap input only after the unchanged bootstrap and worker start.
func preserveEnvironment(body []byte) ([]byte, error) {
	var payload createRequest
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	cleanup := "  - [ \"/usr/bin/rm\", \"-f\", \"/etc/chalk-recorder/bootstrap.env\" ]\n"
	if !strings.HasSuffix(payload.UserData, cleanup) {
		return nil, errors.New("fleet cloud-init cleanup contract changed")
	}
	replacement := "  - [ \"/usr/bin/install\", \"-m\", \"0400\", \"/etc/chalk-recorder/bootstrap.env\", \"/etc/chalk-recorder/diagnostic-bootstrap.env\" ]\n" + cleanup
	original, err := json.Marshal(payload.UserData)
	if err != nil {
		return nil, err
	}
	updated, err := json.Marshal(strings.TrimSuffix(payload.UserData, cleanup) + replacement)
	if err != nil {
		return nil, err
	}
	if bytes.Count(body, original) != 1 {
		return nil, errors.New("ambiguous fleet cloud-init payload")
	}
	return bytes.Replace(body, original, updated, 1), nil
}

func addEvidenceBootCommand(body []byte, command []string) ([]byte, error) {
	var payload createRequest
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	if !strings.HasPrefix(payload.UserData, "#cloud-config\nwrite_files:\n") || len(command) != 3 || command[0] != "/bin/sh" || command[1] != "-c" {
		return nil, errors.New("invalid evidence cloud-init command")
	}
	encoded, err := json.Marshal(command)
	if err != nil {
		return nil, err
	}
	original, err := json.Marshal(payload.UserData)
	if err != nil {
		return nil, err
	}
	updated, err := json.Marshal(strings.Replace(payload.UserData, "#cloud-config\n", "#cloud-config\nbootcmd:\n  - "+string(encoded)+"\n", 1))
	if err != nil {
		return nil, err
	}
	if bytes.Count(body, original) != 1 {
		return nil, errors.New("ambiguous evidence cloud-init payload")
	}
	return bytes.Replace(body, original, updated, 1), nil
}

func (t evidenceTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	var original, body []byte
	var err error
	if request.Body != nil {
		original, err = io.ReadAll(io.LimitReader(request.Body, 1<<20))
		if err != nil {
			return nil, err
		}
		if err := request.Body.Close(); err != nil {
			return nil, err
		}
		body = original
		if request.Method == http.MethodPost && request.URL.Path == "/v2/droplets" {
			body, err = preserveEnvironment(body)
			if err != nil {
				return nil, err
			}
			if t.diagnosticSSHKeyID > 0 {
				body, err = addDiagnosticSSHKey(body, t.diagnosticSSHKeyID)
				if err != nil {
					return nil, err
				}
			}
			if len(t.evidenceBootCommand) > 0 {
				body, err = addEvidenceBootCommand(body, t.evidenceBootCommand)
				if err != nil {
					return nil, err
				}
			}
		}
		request = request.Clone(request.Context())
		request.Body = io.NopCloser(bytes.NewReader(body))
		request.ContentLength = int64(len(body))
	}
	create := request.Method == http.MethodPost && request.URL.Path == "/v2/droplets"
	if create {
		if !t.deadline.IsZero() && !time.Now().Before(t.deadline) {
			return nil, errors.New("cold create deadline expired")
		}
		// A lost response must not turn a cold boot into two billable nodes.
		// Subsequent EnsureNode calls may adopt this intent but cannot POST it again.
		fence, err := os.OpenFile(t.path+".create-pending", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return nil, fmt.Errorf("cold create already submitted or fence unavailable: %w", err)
		}
		if err := fence.Close(); err != nil {
			return nil, err
		}
	}
	response, err := t.next.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	if create && response.StatusCode == http.StatusUnprocessableEntity {
		// DigitalOcean can reject a newly created SSH key before it propagates.
		// A definite 422 did not allocate a node; allow the same intent to retry.
		if err := os.Remove(t.path + ".create-pending"); err != nil {
			response.Body.Close()
			return nil, err
		}
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		response.Body.Close()
		return nil, err
	}
	if err := response.Body.Close(); err != nil {
		return nil, err
	}
	response.Body = io.NopCloser(bytes.NewReader(raw))
	// Bodies only: provider Authorization headers never enter evidence.
	if request.Method != http.MethodGet {
		hash := sha256.Sum256(body)
		entry := auditEntry{Time: time.Now().UTC(), Method: request.Method, Path: request.URL.Path, OriginalBody: original, Body: body, BodySHA256: hex.EncodeToString(hash[:]), Status: response.StatusCode, Response: raw}
		file, err := os.OpenFile(t.path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
		if err != nil {
			return nil, err
		}
		encodeErr := json.NewEncoder(file).Encode(entry)
		closeErr := file.Close()
		if err := errors.Join(encodeErr, closeErr); err != nil {
			return nil, err
		}
	}
	return response, nil
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
	expectedURI := fmt.Sprintf("spiffe://%s/environment/%s/%s/%s", input.TrustDomain, input.Environment, input.Identity.Role, input.Identity.WorkerID)
	if len(certificate.URIs) != 1 || certificate.URIs[0].String() != expectedURI || certificate.SerialNumber.Text(16) != input.Serial {
		return Output{}, errors.New("issuer/installed certificate identity or serial mismatch")
	}
	hash := sha256.Sum256(certificate.Raw)
	return Output{CertificateSHA256: hex.EncodeToString(hash[:]), CertificateSerial: certificate.SerialNumber.Text(16)}, nil
}
