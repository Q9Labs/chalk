package tests

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"runtime"
	"testing"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

func fetch(t *testing.T, client *http.Client, url string) (int, []byte) {
	t.Helper()
	response, err := client.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read %s: %v", url, err)
	}
	return response.StatusCode, body
}

func TestProfilingNeedsTheOperatorIdentity(t *testing.T) {
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca)
	stranger := clientFor(t, ca, ca, "someone-else.test")

	wantStatus, wantBody := fetch(t, stranger, svc.baseURL+"/readyz")
	if wantStatus != http.StatusForbidden {
		t.Fatalf("readiness with the wrong identity: status %d, want 403", wantStatus)
	}
	for _, path := range []string{"/debug/pprof/", "/debug/pprof/heap", "/debug/pprof/goroutine", "/debug/pprof/profile?seconds=1"} {
		if status, body := fetch(t, stranger, svc.baseURL+path); status != wantStatus || !bytes.Equal(body, wantBody) {
			t.Fatalf("%s with the wrong identity: status %d body %q, want the /readyz refusal %d %q", path, status, body, wantStatus, wantBody)
		}
	}

	status, profile := fetch(t, svc.client, svc.baseURL+"/debug/pprof/heap")
	if status != http.StatusOK {
		t.Fatalf("heap profile with the operator identity: status %d, want 200", status)
	}
	if !bytes.HasPrefix(profile, []byte{0x1f, 0x8b}) {
		t.Fatalf("heap profile is not gzip: starts %x", profile[:min(len(profile), 4)])
	}
	if status, _ := fetch(t, svc.client, svc.baseURL+"/debug/pprof/cmdline"); status != http.StatusNotFound {
		t.Fatalf("cmdline: status %d, want 404", status)
	}
}

func TestReadinessReportsProcessMemory(t *testing.T) {
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca)
	status, body := fetch(t, svc.client, svc.baseURL+"/readyz")
	if status != http.StatusOK {
		t.Fatalf("readiness: status %d", status)
	}
	var ready protocol.ReadyResponse
	if err := json.Unmarshal(body, &ready); err != nil {
		t.Fatal(err)
	}
	host := ready.Host
	if host.Goroutines <= 0 || host.HeapInuseBytes == 0 {
		t.Fatalf("goroutines %d, heap in use %d: want both reported", host.Goroutines, host.HeapInuseBytes)
	}
	if runtime.GOOS == "linux" && (host.RSSBytes == nil || *host.RSSBytes < host.HeapInuseBytes) {
		t.Fatalf("resident memory %v, want at least the heap in use %d", host.RSSBytes, host.HeapInuseBytes)
	}
}
