package observability

import (
	"os"
	"path/filepath"
	"strings"
)

// PreviousExit says how the API process before this one ended.
type PreviousExit string

const (
	// PreviousExitClean means the last process finished its shutdown.
	PreviousExitClean PreviousExit = "clean"
	// PreviousExitUnclean means the last process started and never finished a shutdown: a kill, a crash, an
	// out-of-memory exit, a host reset or a startup failure. The marker cannot say which.
	PreviousExitUnclean PreviousExit = "unclean"
	// PreviousExitUnknown means there was no marker: a first start, a new host or a cleaned temporary directory.
	PreviousExitUnknown PreviousExit = "unknown"
)

const (
	markerRunning = "running"
	markerStopped = "stopped"
)

// DefaultLifecycleMarkerPath is a file in the temporary directory. It survives a restart of the process, which
// is the case it exists for, and not a new machine or container.
func DefaultLifecycleMarkerPath() string {
	return filepath.Join(os.TempDir(), "chalk-api-lifecycle")
}

// RecordStart reads how the previous process ended and marks this one as running. A marker that cannot be
// read or written yields unknown: diagnostics must not stop the API from starting.
func RecordStart(path string) PreviousExit {
	previous := PreviousExitUnknown
	if content, err := os.ReadFile(path); err == nil {
		switch strings.TrimSpace(string(content)) {
		case markerStopped:
			previous = PreviousExitClean
		case markerRunning:
			previous = PreviousExitUnclean
		}
	}
	_ = os.WriteFile(path, []byte(markerRunning), 0o600)
	return previous
}

// RecordCleanStop marks that this process finished its shutdown.
func RecordCleanStop(path string) {
	_ = os.WriteFile(path, []byte(markerStopped), 0o600)
}
