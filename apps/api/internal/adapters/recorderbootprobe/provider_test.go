package recorderbootprobe

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestEvidenceCopyDoesNotChangeSignedBootstrapInput(t *testing.T) {
	original := "#cloud-config\nwrite_files:\n  - path: /etc/chalk-recorder/bootstrap.env\n    content: |\n      CHALK_RECORDER_RELEASE='candidate'\nruncmd:\n  - [ \"bootstrap\", \"--require-signed-assertion\" ]\n  - [ \"worker-start\" ]\n  - [ \"/usr/bin/rm\", \"-f\", \"/etc/chalk-recorder/bootstrap.env\" ]\n"
	body, err := json.Marshal(struct {
		Name     string `json:"name"`
		UserData string `json:"user_data"`
	}{Name: "diagnostic", UserData: original})
	if err != nil {
		t.Fatal(err)
	}
	modified, err := preserveEnvironment(body)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Name     string `json:"name"`
		UserData string `json:"user_data"`
	}
	if err := json.Unmarshal(modified, &result); err != nil {
		t.Fatal(err)
	}
	prefix := original[:strings.LastIndex(original, "  - [ \"/usr/bin/rm\"")]
	if result.Name != "diagnostic" || !strings.HasPrefix(result.UserData, prefix) || !strings.Contains(result.UserData, "diagnostic-bootstrap.env") || !strings.HasSuffix(result.UserData, "  - [ \"/usr/bin/rm\", \"-f\", \"/etc/chalk-recorder/bootstrap.env\" ]\n") {
		t.Fatal("evidence hook changed pre-bootstrap input or cleanup")
	}
}

func TestChangedCloudInitContractFailsBeforeCreate(t *testing.T) {
	if _, err := preserveEnvironment([]byte(`{"user_data":"runcmd: []"}`)); err == nil {
		t.Fatal("changed fleet contract was silently accepted")
	}
}

func TestEarlyGuestEvidencePreservesFleetCommands(t *testing.T) {
	original := "#cloud-config\nwrite_files:\n  - path: /etc/chalk-recorder/bootstrap.env\nruncmd:\n  - [\"bootstrap\"]\n  - [\"worker\"]\n"
	body, _ := json.Marshal(createRequest{UserData: original})
	command := []string{"/bin/sh", "-c", "nohup collector >/var/log/evidence 2>&1 &"}
	modified, err := addEvidenceBootCommand(body, command)
	if err != nil {
		t.Fatal(err)
	}
	var result createRequest
	if err := json.Unmarshal(modified, &result); err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(command)
	added := "bootcmd:\n  - " + string(encoded) + "\n"
	if strings.Replace(result.UserData, added, "", 1) != original {
		t.Fatal("evidence changed fleet cloud-init commands")
	}
	if !strings.HasPrefix(result.UserData, "#cloud-config\nbootcmd:") {
		t.Fatal("evidence starts too late")
	}
	if _, err := addEvidenceBootCommand(modified, command); err == nil {
		t.Fatal("duplicate evidence command accepted")
	}
}

func TestCertificateReceiptRejectsWrongIdentitySerialAndTrust(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	root := &x509.Certificate{SerialNumber: big.NewInt(1), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour)}
	rootDER, err := x509.CreateCertificate(rand.Reader, root, root, public, private)
	if err != nil {
		t.Fatal(err)
	}
	uri, err := url.Parse("spiffe://example.test/environment/test/capture/worker")
	if err != nil {
		t.Fatal(err)
	}
	leaf := &x509.Certificate{SerialNumber: big.NewInt(15), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}, URIs: []*url.URL{uri}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Minute)}
	leafDER, err := x509.CreateCertificate(rand.Reader, leaf, root, public, private)
	if err != nil {
		t.Fatal(err)
	}
	input := Input{Environment: "test", Role: workeridentity.RoleCapture, TrustDomain: "example.test", Serial: "f", Identity: recorderfleet.NodeIdentity{Role: workeridentity.RoleCapture, WorkerID: "worker"}, CertificatePEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER})), CAPEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: rootDER}))}
	output, err := verifyCertificate(input)
	if err != nil || len(output.CertificateSHA256) != 64 || output.CertificateSerial != "f" {
		t.Fatalf("valid receipt: %+v, %v", output, err)
	}
	for _, field := range []string{"serial", "identity", "trust", "ca"} {
		t.Run(field, func(t *testing.T) {
			changed := input
			switch field {
			case "serial":
				changed.Serial = "e"
			case "identity":
				changed.Identity.Role = workeridentity.RoleRender
			case "trust":
				changed.TrustDomain = "other.test"
			case "ca":
				changed.CAPEM = "not a certificate"
			}
			if _, err := verifyCertificate(changed); err == nil {
				t.Fatal("mismatched receipt accepted")
			}
		})
	}
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

func TestColdCreateFenceSurvivesAcceptedOrLostResponse(t *testing.T) {
	for _, lost := range []bool{false, true} {
		t.Run(fmt.Sprint(lost), func(t *testing.T) {
			calls := 0
			transport := evidenceTransport{path: filepath.Join(t.TempDir(), "audit.jsonl"), next: roundTripperFunc(func(*http.Request) (*http.Response, error) {
				calls++
				if lost {
					return nil, errors.New("lost provider response")
				}
				return &http.Response{StatusCode: 202, Body: io.NopCloser(strings.NewReader(`{"droplet":{"id":1}}`))}, nil
			})}
			for attempt := range 2 {
				request, err := http.NewRequest(http.MethodPost, "https://example.test/v2/droplets", strings.NewReader(`{"user_data":"runcmd:\n  - [ \"/usr/bin/rm\", \"-f\", \"/etc/chalk-recorder/bootstrap.env\" ]\n"}`))
				if err != nil {
					t.Fatal(err)
				}
				response, err := transport.RoundTrip(request)
				if attempt == 1 && err == nil {
					t.Fatal("second cold create accepted")
				}
				if response != nil {
					response.Body.Close()
				}
			}
			if calls != 1 {
				t.Fatalf("provider creates = %d", calls)
			}
		})
	}
}

func TestColdCreateAllowsDefiniteKeyRejectionRetry(t *testing.T) {
	calls := 0
	transport := evidenceTransport{path: filepath.Join(t.TempDir(), "audit.jsonl"), next: roundTripperFunc(func(*http.Request) (*http.Response, error) {
		calls++
		status := 422
		if calls == 2 {
			status = 202
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})}
	for range 2 {
		request, err := http.NewRequest(http.MethodPost, "https://example.test/v2/droplets", strings.NewReader(`{"user_data":"runcmd:\n  - [ \"/usr/bin/rm\", \"-f\", \"/etc/chalk-recorder/bootstrap.env\" ]\n"}`))
		if err != nil {
			t.Fatal(err)
		}
		response, err := transport.RoundTrip(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
	}
	if calls != 2 {
		t.Fatalf("definite rejection prevented retry: %d", calls)
	}
}

func TestDiagnosticSSHKeyPreservesMaximumFleetKeySet(t *testing.T) {
	body := []byte(`{"ssh_keys":[1,2,3,4,5,6,7,8],"name":"diagnostic","user_data":"unchanged"}`)
	result, err := addDiagnosticSSHKey(body, 9)
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		SSHKeys  []int64 `json:"ssh_keys"`
		UserData string  `json:"user_data"`
	}
	if err := json.Unmarshal(result, &payload); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(payload.SSHKeys, []int64{1, 2, 3, 4, 5, 6, 7, 8, 9}) || payload.UserData != "unchanged" {
		t.Fatalf("fleet keys or boot input changed: %+v", payload)
	}
}

func TestExpiredCreateCannotReachProvider(t *testing.T) {
	transport := evidenceTransport{deadline: time.Now().Add(-time.Second), path: filepath.Join(t.TempDir(), "audit.jsonl"), next: roundTripperFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("expired create reached provider")
		return nil, nil
	})}
	request, err := http.NewRequest(http.MethodPost, "https://example.test/v2/droplets", strings.NewReader(`{"user_data":"runcmd:\n  - [ \"/usr/bin/rm\", \"-f\", \"/etc/chalk-recorder/bootstrap.env\" ]\n"}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := transport.RoundTrip(request); err == nil {
		t.Fatal("expired create accepted")
	}
}
