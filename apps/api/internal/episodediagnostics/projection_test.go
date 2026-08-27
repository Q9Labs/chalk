package episodediagnostics

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"
)

func TestSnapshotSerializesEmptyParticipantsAsArray(t *testing.T) {
	snapshot := NewProjectionState(EpisodeDiagnostic{Environment: EnvironmentLocalhost}).Snapshot("chalkdiag:v1:localhost:test", time.Unix(0, 0).UTC())
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(encoded, []byte(`"participants":[]`)) {
		t.Fatalf("snapshot = %s, want an empty participants array", encoded)
	}
}
