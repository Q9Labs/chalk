package digitalocean

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func TestRecorderCloudInitStopsBeforeWorkerAndCleanupOnBootstrapFailure(t *testing.T) {
	data, err := renderRecorderCloudInit(recorderFleetEnsureRequest())
	if err != nil {
		t.Fatal(err)
	}
	_, commands, ok := strings.Cut(data, "\nruncmd:\n")
	if !ok {
		t.Fatal("missing cloud-init commands")
	}
	directory := t.TempDir()
	marker := filepath.Join(directory, "worker-or-cleanup-ran")
	bootstrap := filepath.Join(directory, "bootstrap")
	next := filepath.Join(directory, "next")
	if err := os.WriteFile(bootstrap, []byte("#!/bin/sh\nexit 23\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(next, []byte("#!/bin/sh\nprintf ran > \""+marker+"\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	// cloud-init shellifies scalar commands directly and quotes array arguments.
	var script strings.Builder
	script.WriteString("#!/bin/sh\n")
	for _, line := range strings.Split(strings.TrimSpace(commands), "\n") {
		command := strings.TrimPrefix(strings.TrimSpace(line), "- ")
		if !strings.HasPrefix(command, "[") {
			script.WriteString(command + "\n")
			continue
		}
		var args []string
		if err := json.Unmarshal([]byte(command), &args); err != nil {
			t.Fatal(err)
		}
		if args[0] == "/usr/local/sbin/chalk-recorder-bootstrap" {
			args[0] = bootstrap
		} else {
			args[0] = next
		}
		for _, arg := range args {
			script.WriteString("'" + strings.ReplaceAll(arg, "'", "'\\''") + "' ")
		}
		script.WriteByte('\n')
	}
	run := exec.Command("/bin/sh", "-c", script.String())
	err = run.Run()
	var exited *exec.ExitError
	if !errors.As(err, &exited) || exited.ExitCode() != 23 {
		t.Fatalf("failed bootstrap was hidden: %v", err)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("worker/cleanup ran after failed bootstrap: %v", err)
	}
}

func TestRecorderFleetEnsureCreatesFencedNodeAndAttachesFirewall(t *testing.T) {
	request := recorderFleetEnsureRequest()
	secret := "digitalocean-secret-token"
	var createCalls, projectCalls, attachCalls int
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, httpRequest *http.Request) {
		if httpRequest.Header.Get("Authorization") != "Bearer "+secret {
			t.Errorf("authorization header missing")
		}
		switch {
		case httpRequest.Method == http.MethodGet && httpRequest.URL.Path == "/v2/droplets":
			if httpRequest.URL.Query().Get("name") != request.Name {
				t.Errorf("name query = %q", httpRequest.URL.RawQuery)
			}
			writeJSON(t, writer, http.StatusOK, map[string]any{"droplets": []any{}, "links": map[string]any{"pages": map[string]any{}}})
		case httpRequest.Method == http.MethodPost && httpRequest.URL.Path == "/v2/droplets":
			createCalls++
			var body createDropletRequest
			if err := json.NewDecoder(httpRequest.Body).Decode(&body); err != nil {
				t.Errorf("decode create request: %v", err)
			}
			if body.Name != request.Name || body.Image != request.Release.ImageID || body.Region != request.Release.Region || body.Size != request.Release.Size || !slices.Equal(body.Tags, request.RequiredTags) || !slices.Equal(body.SSHKeys, []int64{17}) {
				t.Errorf("create body = %+v", body)
			}
			if body.Monitoring || body.WithDropletAgent {
				t.Errorf("recorder agents must be disabled: %+v", body)
			}
			if strings.Contains(body.UserData, secret) || strings.Contains(body.UserData, "CHALK_RECORDER_BOOTSTRAP_ASSERTION=") {
				t.Errorf("cloud-init contains reusable secret or assertion: %q", body.UserData)
			}
			for _, required := range []string{"--one-time", "--require-signed-assertion", "--require-droplet-inventory-match", "--require-boot-generation", "CHALK_RECORDER_BOOT_GENERATION='1'", "chalk-recorder-capture.service"} {
				if !strings.Contains(body.UserData, required) {
					t.Errorf("cloud-init missing %q", required)
				}
			}
			if strings.Contains(body.UserData, "source /etc/chalk-recorder/bootstrap.env") {
				t.Errorf("cloud-init executes bootstrap environment as shell: %q", body.UserData)
			}
			writeJSON(t, writer, http.StatusAccepted, map[string]any{"droplet": dropletResponse(request, 123)})
		case httpRequest.Method == http.MethodPost && httpRequest.URL.Path == "/v2/projects/project-1/resources":
			projectCalls++
			var body projectResourcesRequest
			if err := json.NewDecoder(httpRequest.Body).Decode(&body); err != nil || !slices.Equal(body.Resources, []string{"do:droplet:123"}) {
				t.Errorf("project assignment body = %+v, err %v", body, err)
			}
			writeJSON(t, writer, http.StatusOK, map[string]any{"resources": []map[string]any{{"urn": "do:droplet:123", "status": "assigned"}}})
		case httpRequest.Method == http.MethodPost && httpRequest.URL.Path == "/v2/firewalls/firewall-1/droplets":
			attachCalls++
			var body firewallDropletsRequest
			if err := json.NewDecoder(httpRequest.Body).Decode(&body); err != nil || !slices.Equal(body.DropletIDs, []int64{123}) {
				t.Errorf("firewall attach body = %+v, err %v", body, err)
			}
			writer.WriteHeader(http.StatusNoContent)
		case httpRequest.Method == http.MethodGet && httpRequest.URL.Path == "/v2/droplets/123/firewalls":
			writeJSON(t, writer, http.StatusOK, map[string]any{"firewalls": []map[string]any{{"id": "firewall-1"}}})
		default:
			t.Errorf("unexpected request %s %s", httpRequest.Method, httpRequest.URL.String())
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	adapter := recorderFleetAdapter(t, server, secret)

	node, err := adapter.EnsureNode(t.Context(), request)
	if err != nil {
		t.Fatalf("ensure node: %v", err)
	}
	if node.ProviderID != "123" || !slices.Contains(node.FirewallIDs, "firewall-1") || node.BootGeneration != 1 {
		t.Fatalf("node = %+v", node)
	}
	if createCalls != 1 || projectCalls != 1 || attachCalls != 1 {
		t.Fatalf("create/project/attach calls = %d/%d/%d", createCalls, projectCalls, attachCalls)
	}
}

func TestRecorderFleetEnsureRejectsDriftedAdoptionBeforeMutation(t *testing.T) {
	request := recorderFleetEnsureRequest()
	mutations := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, httpRequest *http.Request) {
		switch {
		case httpRequest.Method == http.MethodGet && httpRequest.URL.Path == "/v2/droplets":
			droplet := dropletResponse(request, 456)
			droplet["image"] = map[string]any{"id": request.Release.ImageID + 1}
			writeJSON(t, writer, http.StatusOK, map[string]any{"droplets": []any{droplet}, "links": map[string]any{"pages": map[string]any{}}})
		case httpRequest.Method == http.MethodGet && httpRequest.URL.Path == "/v2/droplets/456/firewalls":
			writeJSON(t, writer, http.StatusOK, map[string]any{"firewalls": []map[string]any{{"id": "firewall-1"}}})
		default:
			mutations++
			writer.WriteHeader(http.StatusNoContent)
		}
	}))
	defer server.Close()
	adapter := recorderFleetAdapter(t, server, "token")

	_, err := adapter.EnsureNode(t.Context(), request)
	if err != recorderfleet.ErrInventoryDrift {
		t.Fatalf("error = %v, want inventory drift", err)
	}
	if mutations != 0 {
		t.Fatalf("drifted node caused %d mutations", mutations)
	}
}

func TestRecorderFleetDeleteRechecksExactOwnership(t *testing.T) {
	request := recorderFleetEnsureRequest()
	deleteCalls := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, httpRequest *http.Request) {
		switch {
		case httpRequest.Method == http.MethodGet && httpRequest.URL.Path == "/v2/droplets/789":
			writeJSON(t, writer, http.StatusOK, map[string]any{"droplet": dropletResponse(request, 789)})
		case httpRequest.Method == http.MethodDelete && httpRequest.URL.Path == "/v2/droplets/789":
			deleteCalls++
			writer.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected request %s %s", httpRequest.Method, httpRequest.URL.String())
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	adapter := recorderFleetAdapter(t, server, "token")

	err := adapter.DeleteNode(t.Context(), recorderfleet.DeleteNodeRequest{ProviderID: "789", Name: "wrong-name", RequiredTags: request.RequiredTags})
	if err != recorderfleet.ErrInventoryDrift || deleteCalls != 0 {
		t.Fatalf("wrong-name delete error/calls = %v/%d", err, deleteCalls)
	}
	err = adapter.DeleteNode(t.Context(), recorderfleet.DeleteNodeRequest{ProviderID: "789", Name: request.Name, RequiredTags: request.RequiredTags})
	if err != nil || deleteCalls != 1 {
		t.Fatalf("exact delete error/calls = %v/%d", err, deleteCalls)
	}
}

func TestRecorderFleetErrorsNeverExposeTokenOrProviderBody(t *testing.T) {
	secret := "never-log-this-token"
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusInternalServerError)
		_, _ = writer.Write([]byte("provider body contains private detail"))
	}))
	defer server.Close()
	adapter := recorderFleetAdapter(t, server, secret)

	_, err := adapter.ListNodes(t.Context(), recorderfleet.PoolKey{Environment: "staging", Role: workeridentity.RoleCapture})
	if err == nil || strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), "private detail") {
		t.Fatalf("unsafe provider error = %v", err)
	}
}

func TestNewRecorderFleetAcceptsCPURenderPool(t *testing.T) {
	t.Parallel()
	adapter, err := NewRecorderFleet(RecorderFleetConfig{
		Token: "token", BaseURL: "https://api.digitalocean.com", Environment: "staging",
		Role: workeridentity.RoleRender, OwnerTag: "chalk-recorder-owned", GPU: false,
	})
	if err != nil || adapter.gpu {
		t.Fatalf("CPU render adapter/error = %#v/%v", adapter, err)
	}
}

func TestRecorderFleetInspectNodeReturnsFreshExactInventoryAndExclusivePublicIP(t *testing.T) {
	request := recorderFleetEnsureRequest()
	request.RequiredTags = append(request.RequiredTags, recorderfleet.DiagnosticTag)
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, httpRequest *http.Request) {
		switch httpRequest.URL.Path {
		case "/v2/droplets/123":
			droplet := dropletResponse(request, 123)
			droplet["networks"] = map[string]any{"v4": []map[string]any{
				{"ip_address": "10.0.0.4", "type": "private"},
				{"ip_address": "192.0.2.10", "type": "public"},
			}}
			writeJSON(t, writer, http.StatusOK, map[string]any{"droplet": droplet})
		case "/v2/droplets/123/firewalls":
			writeJSON(t, writer, http.StatusOK, map[string]any{"firewalls": []map[string]any{{"id": "firewall-1"}}})
		default:
			t.Errorf("unexpected request %s", httpRequest.URL.Path)
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	adapter := recorderFleetAdapter(t, server, "token")

	node, publicIP, err := adapter.InspectNode(t.Context(), request.Key, "123")
	if err != nil || publicIP.String() != "192.0.2.10" || node.ProviderID != "123" || !slices.Equal(node.FirewallIDs, []string{"firewall-1"}) {
		t.Fatalf("inspected node/IP/error = %+v/%v/%v", node, publicIP, err)
	}
}

func recorderFleetAdapter(t *testing.T, server *httptest.Server, token string) *RecorderFleet {
	t.Helper()
	adapter, err := NewRecorderFleet(RecorderFleetConfig{
		Token: token, BaseURL: server.URL, HTTPClient: server.Client(),
		Environment: "staging", Role: workeridentity.RoleCapture,
		OwnerTag: "chalk-recorder-owned", ProjectID: "project-1", VPCUUID: "vpc-1", SSHKeyIDs: []int64{17},
	})
	if err != nil {
		t.Fatalf("new adapter: %v", err)
	}
	return adapter
}

func recorderFleetEnsureRequest() recorderfleet.EnsureNodeRequest {
	key := recorderfleet.PoolKey{Environment: "staging", Role: workeridentity.RoleCapture}
	release := recorderfleet.ReleaseSpec{
		ReleaseID: "release-1", ImageID: 1234,
		ImageDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Region:      "sgp1", Size: "c-2", FirewallID: "firewall-1",
		BootstrapEndpoint: "https://bootstrap.internal.example.test/v1/assertions",
	}
	return recorderfleet.EnsureNodeRequest{
		Key: key, Name: recorderfleet.NodeName(key, release.ReleaseID, 1), OwnerTag: "chalk-recorder-owned",
		BootGeneration: 1, Release: release,
		RequiredTags: recorderfleet.RequiredTags(key, "chalk-recorder-owned", release, 1),
	}
}

func dropletResponse(request recorderfleet.EnsureNodeRequest, id int64) map[string]any {
	return map[string]any{
		"id": id, "name": request.Name, "status": "active", "size_slug": request.Release.Size,
		"created_at": time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC).Format(time.RFC3339),
		"region":     map[string]any{"slug": request.Release.Region}, "image": map[string]any{"id": request.Release.ImageID},
		"tags": request.RequiredTags,
	}
}

func writeJSON(t *testing.T, writer http.ResponseWriter, status int, value any) {
	t.Helper()
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	if err := json.NewEncoder(writer).Encode(value); err != nil {
		t.Errorf("encode response: %v", err)
	}
}

func TestInspectNodeWaitsForPublicIPButRejectsInvalidInventory(t *testing.T) {
	request := recorderFleetEnsureRequest()
	for _, test := range []struct {
		name      string
		networks  []map[string]any
		wrongTags bool
		status    string
		want      error
	}{
		{"pending public IP", nil, false, "active", recorderfleet.ErrInventoryNotReady},
		{"new without IP", nil, false, "new", recorderfleet.ErrInventoryNotReady},
		{"off without IP", nil, false, "off", recorderfleet.ErrInventoryDrift},
		{"malformed public IP", []map[string]any{{"type": "public", "ip_address": "not-an-ip"}}, false, "active", recorderfleet.ErrInventoryDrift},
		{"multiple public IPs", []map[string]any{{"type": "public", "ip_address": "192.0.2.10"}, {"type": "public", "ip_address": "192.0.2.11"}}, false, "active", recorderfleet.ErrInventoryDrift},
		{"wrong tags without IP", nil, true, "new", recorderfleet.ErrInventoryDrift},
	} {
		t.Run(test.name, func(t *testing.T) {
			ready := false
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v2/droplets/123":
					droplet := dropletResponse(request, 123)
					droplet["status"] = test.status
					networks := test.networks
					if ready {
						networks = []map[string]any{{"type": "public", "ip_address": "192.0.2.10"}}
						droplet["status"] = "active"
					}
					if test.wrongTags && !ready {
						droplet["tags"] = []string{"other"}
					}
					droplet["networks"] = map[string]any{"v4": networks}
					writeJSON(t, w, http.StatusOK, map[string]any{"droplet": droplet})
				case "/v2/droplets/123/firewalls":
					writeJSON(t, w, http.StatusOK, map[string]any{"firewalls": []map[string]any{{"id": "firewall-1"}}})
				default:
					t.Errorf("unexpected request %s", r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer server.Close()
			adapter := recorderFleetAdapter(t, server, "secret-digitalocean-token")
			node, ip, err := adapter.InspectNode(t.Context(), request.Key, "123")
			if !errors.Is(err, test.want) || ip.IsValid() {
				t.Fatalf("node/IP/error = %+v/%v/%v, want %v", node, ip, err, test.want)
			}
			if errors.Is(test.want, recorderfleet.ErrInventoryNotReady) && node.ProviderID != "123" {
				t.Fatal("pending view lost identity inventory")
			}
			ready = true
			_, ip, err = adapter.InspectNode(t.Context(), request.Key, "123")
			if err != nil || ip.String() != "192.0.2.10" {
				t.Fatalf("ready retry = %v/%v", ip, err)
			}
		})
	}
}
