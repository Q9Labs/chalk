package media

import (
	"os"
	"path/filepath"
	"runtime"
	"sync"
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
	// Other goroutines in the test binary can end between the two readings, so start several and
	// require most of them to show. Each reports in once it is running, so none is still waiting
	// to be scheduled when the second reading is taken. The cleanup waits for them to finish so
	// they cannot leak into the baseline of a later run.
	const started = 32
	goroutines, _ := readRuntime()
	stop := make(chan struct{})
	var finished sync.WaitGroup
	t.Cleanup(func() {
		close(stop)
		finished.Wait()
	})
	running := make(chan struct{}, started)
	for range started {
		finished.Add(1)
		go func() {
			defer finished.Done()
			running <- struct{}{}
			<-stop
		}()
	}
	for range started {
		<-running
	}

	// A live slice is in the heap whatever the baseline or any collection does, so the reading
	// must be at least its size.
	const size = 64 << 20
	live := make([]byte, size)
	for offset := 0; offset < size; offset += os.Getpagesize() {
		live[offset] = 1
	}
	moreGoroutines, heap := readRuntime()
	runtime.KeepAlive(live)
	if moreGoroutines < goroutines+started/2 {
		t.Fatalf("goroutines %d then %d after starting %d, want a rise of at least %d", goroutines, moreGoroutines, started, started/2)
	}
	if heap < size {
		t.Fatalf("heap in use %d while keeping %d bytes live", heap, size)
	}
}
