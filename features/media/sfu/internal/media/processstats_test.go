package media

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadRSS(t *testing.T) {
	path := filepath.Join(t.TempDir(), "statm")
	if err := os.WriteFile(path, []byte("5000 1200 300 10 0 900 0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, known := readRSS(path)
	if want := 1200 * uint64(os.Getpagesize()); !known || got != want {
		t.Fatalf("readRSS = %d, %v; want %d, true", got, known, want)
	}
	if _, known := readRSS(filepath.Join(t.TempDir(), "missing")); known {
		t.Fatal("a missing file reported a reading")
	}
}

var retained []byte

func TestReadRuntime(t *testing.T) {
	goroutines, _ := readRuntime()
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	go func() { <-stop }()
	retained = make([]byte, 8<<20)
	t.Cleanup(func() { retained = nil })
	moreGoroutines, heap := readRuntime()
	if moreGoroutines <= goroutines {
		t.Fatalf("goroutines %d then %d after starting one, want a rise", goroutines, moreGoroutines)
	}
	// The kept 8 MiB is live, so in-use heap holds it however much garbage a collection frees.
	if heap < uint64(len(retained)) {
		t.Fatalf("heap in use %d while keeping %d bytes", heap, len(retained))
	}
}
