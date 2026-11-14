package provideroperations_test

import (
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/depcheck"
)

// The media control ledger depends on recording limits through artifactpolicy
// only; the recording pipeline changes too often to sit under it.
func TestLedgerDoesNotDependOnTheRecordingPipeline(t *testing.T) {
	depcheck.Forbid(t, "recordingpipeline", "recordingobjects", "recorderworker")
}
