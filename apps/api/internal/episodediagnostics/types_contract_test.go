package episodediagnostics

import (
	"encoding/json"
	"testing"
)

func TestAppendDiagnosticEventsResultUsesEmptyAcknowledgementArrays(t *testing.T) {
	encoded, err := json.Marshal(AppendDiagnosticEventsResult{DiagnosticReference: "chalkdiag:v1:localhost:diag01"})
	if err != nil {
		t.Fatalf("marshal append result: %v", err)
	}

	var decoded struct {
		Accepted   []AppendEventReceipt `json:"accepted"`
		Duplicates []AppendEventReceipt `json:"duplicates"`
		Conflicts  []AppendConflict     `json:"conflicts"`
	}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal append result: %v", err)
	}
	if decoded.Accepted == nil || decoded.Duplicates == nil || decoded.Conflicts == nil {
		t.Fatalf("append acknowledgement arrays were null: %s", encoded)
	}
}
