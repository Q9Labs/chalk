package recorderfleetissuer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func TestClientUsesBoundedIssuerProtocol(t *testing.T) {
	t.Parallel()
	request := issuerBootstrapRequest()
	identity := recorderfleet.NodeIdentity{
		ProviderID: request.ProviderID, WorkerID: "55555555-5555-4555-8555-555555555555",
		Role: request.Key.Role, BootGeneration: request.BootGeneration,
	}
	calls := 0
	client, err := NewWithHTTPClient("https://issuer.example", &http.Client{Transport: issuerRoundTripFunc(func(got *http.Request) (*http.Response, error) {
		calls++
		if got.Method != http.MethodPost || got.Header.Get("Content-Type") != "application/json" {
			t.Fatalf("request = %s content-type=%q", got.Method, got.Header.Get("Content-Type"))
		}
		defer got.Body.Close()
		var body map[string]any
		if err := json.NewDecoder(got.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		switch got.URL.Path {
		case bootstrapPath:
			if body["schema_version"] != BootstrapSchemaVersion || body["provider_id"] != request.ProviderID || body["key"] == nil {
				t.Fatalf("bootstrap body = %#v", body)
			}
			if _, leaked := body["assertion"]; leaked {
				t.Fatalf("bootstrap request contains an assertion: %#v", body)
			}
			return issuerJSONResponse(http.StatusOK, `{"schema_version":"recorder_fleet_issuer_bootstrap.v1","identity":{"provider_id":"provider-7","worker_id":"55555555-5555-4555-8555-555555555555","role":"capture","boot_generation":7}}`), nil
		case revokePath:
			if body["schema_version"] != RevokeSchemaVersion || body["identity"] == nil {
				t.Fatalf("revoke body = %#v", body)
			}
			return issuerJSONResponse(http.StatusNoContent, ""), nil
		default:
			t.Fatalf("path = %q", got.URL.Path)
			return nil, errors.New("unexpected path")
		}
	})})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	issued, err := client.EnsureBootstrap(context.Background(), request)
	if err != nil || issued != identity {
		t.Fatalf("issued/error = %#v/%v", issued, err)
	}
	if err := client.RevokeIdentity(context.Background(), identity); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if calls != 2 {
		t.Fatalf("calls = %d", calls)
	}
}

func TestClientRejectsMismatchedAndMalformedIssuerResponses(t *testing.T) {
	t.Parallel()
	request := issuerBootstrapRequest()
	for name, response := range map[string]string{
		"wrong provider": `{"schema_version":"recorder_fleet_issuer_bootstrap.v1","identity":{"provider_id":"other","worker_id":"55555555-5555-4555-8555-555555555555","role":"capture","boot_generation":7}}`,
		"unknown field":  `{"schema_version":"recorder_fleet_issuer_bootstrap.v1","identity":{},"assertion":"secret"}`,
	} {
		t.Run(name, func(t *testing.T) {
			client, _ := NewWithHTTPClient("https://issuer.example", &http.Client{Transport: issuerRoundTripFunc(func(*http.Request) (*http.Response, error) {
				return issuerJSONResponse(http.StatusOK, response), nil
			})})
			_, err := client.EnsureBootstrap(context.Background(), request)
			if name == "wrong provider" && !errors.Is(err, recorderfleet.ErrRoleFence) {
				t.Fatalf("error = %v", err)
			}
			if name == "unknown field" && (!errors.Is(err, recorderfleet.ErrProviderUnavailable) || strings.Contains(err.Error(), "secret")) {
				t.Fatalf("bounded error = %v", err)
			}
		})
	}
}

func TestUnavailableAuthorityFailsClosed(t *testing.T) {
	t.Parallel()
	authority := UnavailableAuthority{}
	if _, err := authority.EnsureBootstrap(t.Context(), issuerBootstrapRequest()); !errors.Is(err, recorderfleet.ErrProviderUnavailable) {
		t.Fatalf("ensure error = %v", err)
	}
	if err := authority.RevokeIdentity(t.Context(), recorderfleet.NodeIdentity{}); !errors.Is(err, recorderfleet.ErrProviderUnavailable) {
		t.Fatalf("revoke error = %v", err)
	}
}

func TestNewWithHTTPClientRequiresExactHTTPSOrigin(t *testing.T) {
	t.Parallel()
	for _, rawURL := range []string{"", "http://issuer.example", "https://user@issuer.example", "https://issuer.example/path", "https://issuer.example?query=true"} {
		if _, err := NewWithHTTPClient(rawURL, &http.Client{}); !errors.Is(err, recorderfleet.ErrInvalidConfig) {
			t.Fatalf("URL %q error = %v", rawURL, err)
		}
	}
	if _, err := NewWithHTTPClient("https://issuer.example", nil); !errors.Is(err, recorderfleet.ErrInvalidConfig) {
		t.Fatalf("nil client error = %v", err)
	}
}

func issuerBootstrapRequest() recorderfleet.BootstrapRequest {
	return recorderfleet.BootstrapRequest{
		Key:        recorderfleet.PoolKey{Environment: "staging", Role: workeridentity.RoleCapture},
		ProviderID: "provider-7", NodeName: "capture-7", Region: "fra1", ReleaseID: "release-7",
		ImageDigest: "sha256:" + strings.Repeat("a", 64), BootGeneration: 7,
		InventoryDigest: strings.Repeat("b", 64),
	}
}

func issuerJSONResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}

type issuerRoundTripFunc func(*http.Request) (*http.Response, error)

func (function issuerRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}
