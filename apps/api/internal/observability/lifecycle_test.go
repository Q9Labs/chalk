package observability

import (
	"path/filepath"
	"testing"
)

func TestLifecycleMarkerSaysHowThePreviousProcessEnded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "marker")
	if got := RecordStart(path); got != PreviousExitUnknown {
		t.Fatalf("first start = %q, want unknown", got)
	}
	if got := RecordStart(path); got != PreviousExitUnclean {
		t.Fatalf("start after a process that never stopped = %q, want unclean", got)
	}
	RecordCleanStop(path)
	if got := RecordStart(path); got != PreviousExitClean {
		t.Fatalf("start after a clean stop = %q, want clean", got)
	}
}

func TestLifecycleMarkerFailureDoesNotStopStartup(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "no-such-dir", "marker")
	if got := RecordStart(missing); got != PreviousExitUnknown {
		t.Fatalf("unwritable marker = %q, want unknown", got)
	}
	RecordCleanStop(missing)
}
