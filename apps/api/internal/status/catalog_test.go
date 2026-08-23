package status

import "testing"

func TestSyncDiagnosticsMonitorIsKnown(t *testing.T) {
	if _, ok := knownMonitorKeys()["sync.diagnostics"]; !ok {
		t.Fatal("sync diagnostics monitor must be accepted by status ingestion")
	}
}
