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
	"testing"

	controlplane "github.com/q9labs/chalk/apps/document-renderer/internal/control"
	"github.com/q9labs/chalk/apps/document-renderer/internal/render"
)

func init() {
	if mode := os.Getenv("RENDER_CHILD_MODE"); mode == "inventory" || mode == "page" || mode == "image" || mode == "timeout-probe" || mode == "office" {
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
	jobDirectory := filepath.Dir(path)
	if filepath.Dir(jobDirectory) != rendererScratchRoot {
		t.Fatalf("source path %q is not under the renderer scratch root", path)
	}
	if err := cleanup(); err != nil {
		t.Fatalf("clean scratch: %v", err)
	}
	if _, err := os.Stat(jobDirectory); !os.IsNotExist(err) {
		t.Fatalf("renderer job scratch remains after cleanup: %v", err)
	}
	entries, err := os.ReadDir(rendererScratchRoot)
	if err != nil {
		t.Fatalf("read renderer scratch root: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("renderer scratch root has %d entries after cleanup", len(entries))
	}
}

func TestRendererScratchResetWipesRoot(t *testing.T) {
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
}

func TestResetWritableTempRemovesBootEntries(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "leftover"), []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "nested", "job"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "nested", "job", "source"), []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := resetWritableTemp(root); err != nil {
		t.Fatalf("reset writable temp: %v", err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("read writable temp after reset: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("writable temp has %d entries after boot reset", len(entries))
	}
	if _, err := os.Stat(root); err != nil {
		t.Fatalf("writable temp root was removed: %v", err)
	}
}

func TestResetWritableTempReturnsUndeletableEntryFailure(t *testing.T) {
	root := t.TempDir()
	protectedPath := filepath.Join(root, "retained-job-file")
	if err := os.WriteFile(protectedPath, []byte("tenant bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	removeFailure := os.ErrPermission
	err := resetWritableTempRemoving(root, func(path string) error {
		if path == protectedPath {
			return removeFailure
		}
		return os.RemoveAll(path)
	})
	if !errors.Is(err, removeFailure) {
		t.Fatalf("reset writable temp error = %v; want undeletable-file failure", err)
	}
}

func TestCleanupRendererScratchPreservesSiblingJob(t *testing.T) {
	if err := ResetRendererScratch(); err != nil {
		t.Fatalf("reset scratch: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(rendererScratchRoot) })
	finishedPath, finishCleanup, err := writeSource([]byte("finished"))
	if err != nil {
		t.Fatalf("write finished source: %v", err)
	}
	siblingPath, siblingCleanup, err := writeSource([]byte("sibling"))
	if err != nil {
		t.Fatalf("write sibling source: %v", err)
	}
	markerPath := filepath.Join(filepath.Dir(siblingPath), "still-rendering")
	if err := os.WriteFile(markerPath, []byte("rendering"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := finishCleanup(); err != nil {
		t.Fatalf("clean finished job scratch: %v", err)
	}
	if _, err := os.Stat(filepath.Dir(finishedPath)); !os.IsNotExist(err) {
		t.Fatalf("finished job scratch remains: %v", err)
	}
	for _, path := range []string{siblingPath, markerPath} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("sibling job file %q was removed: %v", path, err)
		}
	}
	if err := siblingCleanup(); err != nil {
		t.Fatalf("clean sibling job scratch: %v", err)
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
	mux.HandleFunc("/internal/v1/presenting/render/inventory/complete", func(w http.ResponseWriter, _ *http.Request) {
		entries, err := os.ReadDir(rendererScratchRoot)
		if err != nil && !os.IsNotExist(err) {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		if len(entries) != 0 {
			w.WriteHeader(http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
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
	entries, err := os.ReadDir(rendererScratchRoot)
	if err != nil {
		t.Fatalf("read renderer scratch root after job: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("renderer scratch root has %d entries after job", len(entries))
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
