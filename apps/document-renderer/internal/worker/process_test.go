package worker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	controlplane "github.com/q9labs/chalk/apps/document-renderer/internal/control"
	"github.com/q9labs/chalk/apps/document-renderer/internal/render"
)

func init() {
	if mode := os.Getenv("RENDER_CHILD_MODE"); mode == "inventory" || mode == "page" || mode == "image" || mode == "timeout-probe" {
		os.Exit(render.RunChild(mode, os.Args[1:]))
	}
}

func TestWriteSourceCleanupRemovesRendererScratch(t *testing.T) {
	if err := ResetRendererScratch(); err != nil {
		t.Fatalf("reset scratch: %v", err)
	}
	path, cleanup, err := writeSource([]byte("pdf"))
	if err != nil {
		t.Fatalf("write source: %v", err)
	}
	if filepath.Dir(filepath.Dir(path)) != rendererScratchRoot {
		t.Fatalf("source path %q is not under the renderer scratch root", path)
	}
	if err := cleanup(); err != nil {
		t.Fatalf("clean scratch: %v", err)
	}
	if _, err := os.Stat(rendererScratchRoot); !os.IsNotExist(err) {
		t.Fatalf("renderer scratch root remains after cleanup: %v", err)
	}
}

func TestRendererScratchResetAndCleanupWipeLeftovers(t *testing.T) {
	if err := os.MkdirAll(rendererScratchRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rendererScratchRoot, "boot-leftover"), []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ResetRendererScratch(); err != nil {
		t.Fatalf("reset scratch: %v", err)
	}
	if _, err := os.Stat(rendererScratchRoot); !os.IsNotExist(err) {
		t.Fatalf("renderer scratch root remains after boot reset: %v", err)
	}

	_, cleanup, err := writeSource([]byte("pdf"))
	if err != nil {
		t.Fatalf("write source: %v", err)
	}
	if err := os.WriteFile(filepath.Join(rendererScratchRoot, "job-leftover"), []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	err = cleanup()
	if err == nil || !strings.Contains(err.Error(), "unexpected entries") {
		t.Fatalf("cleanup error = %v; want unexpected scratch entry failure", err)
	}
	if _, statErr := os.Stat(rendererScratchRoot); !os.IsNotExist(statErr) {
		t.Fatalf("renderer scratch root remains after leftover cleanup: %v", statErr)
	}
}

func TestProcessInventoryJobLeavesNoRendererScratch(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("webp rendering is Linux-only")
	}
	if err := ResetRendererScratch(); err != nil {
		t.Fatalf("reset scratch: %v", err)
	}
	var source bytes.Buffer
	if err := png.Encode(&source, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(source.Bytes())
	mux := http.NewServeMux()
	mux.HandleFunc("/source", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(source.Bytes()) })
	mux.HandleFunc("/upload/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/internal/v1/presenting/render/inventory/complete", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	mux.HandleFunc("/internal/v1/presenting/render/fail", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	server := httptest.NewServer(mux)
	defer server.Close()
	upload := controlplane.SignedUpload{URL: server.URL + "/upload/rendition", Headers: map[string]string{}}
	assignment := controlplane.Assignment{
		JobID: "job", TenantID: "tenant", SpaceID: "space", DocumentID: "document", Kind: "inventory", PageStart: 1, PageEnd: 1, Attempt: 1,
		MIMEType: "image/png", SourceURL: server.URL + "/source", SourceSizeBytes: int64(source.Len()), SourceSHA256: hex.EncodeToString(digest[:]),
		Uploads: []controlplane.PageUploads{{Page: 1, Image: upload, Thumbnail: upload}},
	}
	if err := Process(context.Background(), controlplane.NewControlClient(server.URL), assignment); err != nil {
		t.Fatalf("process inventory job: %v", err)
	}
	if _, err := os.Stat(rendererScratchRoot); !os.IsNotExist(err) {
		t.Fatalf("renderer scratch root remains after job: %v", err)
	}
}

func TestIsolatedRenderFailureClassifiesSandboxSetupAsInfrastructure(t *testing.T) {
	err := isolatedRenderFailure(isolatedSandboxError{err: errors.New("namespace unavailable")})
	var failure renderFailure
	if !errors.As(err, &failure) || failure.code != "infrastructure" {
		t.Fatalf("sandbox setup classification = %#v", err)
	}
}

func TestFinishFailureRecyclesAfterIsolatedChildCompromise(t *testing.T) {
	control, closeServer := testControlClient(t)
	defer closeServer()
	err := finishFailure(context.Background(), control, controlplane.Assignment{}, "corrupt", isolatedChildCompromiseError{err: errors.New("parser crashed")})
	if err == nil {
		t.Fatal("parser compromise did not request renderer process recycling")
	}
}

func TestFinishFailureDoesNotRecycleOrdinaryDocumentFailure(t *testing.T) {
	control, closeServer := testControlClient(t)
	defer closeServer()
	if err := finishFailure(context.Background(), control, controlplane.Assignment{}, "password_protected", errors.New("encrypted document")); err != nil {
		t.Fatalf("ordinary document failure: %v", err)
	}
}

func testControlClient(t *testing.T) (controlplane.ControlClient, func()) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/v1/presenting/render/fail" {
			t.Errorf("unexpected control path %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	return controlplane.NewControlClient(server.URL), server.Close
}
