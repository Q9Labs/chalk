package media

import (
	"os"
	"path/filepath"
	"runtime"
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

func TestReadRuntime(t *testing.T) {
	goroutines, _ := readRuntime()
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	go func() { <-stop }()

	// A live slice is in the heap whatever the baseline or any collection does, so the reading
	// must be at least its size.
	const size = 64 << 20
	live := make([]byte, size)
	for offset := 0; offset < size; offset += os.Getpagesize() {
		live[offset] = 1
	}
	moreGoroutines, heap := readRuntime()
	runtime.KeepAlive(live)
	if moreGoroutines <= goroutines {
		t.Fatalf("goroutines %d then %d after starting one, want a rise", goroutines, moreGoroutines)
	}
	if heap < size {
		t.Fatalf("heap in use %d while keeping %d bytes live", heap, size)
	}
}
