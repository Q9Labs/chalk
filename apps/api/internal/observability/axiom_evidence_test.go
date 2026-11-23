package observability

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAxiomEvidenceUsesIngestPathForItsHost(t *testing.T) {
	for _, test := range []struct{ endpoint, want string }{
		{"https://api.axiom.co", "https://api.axiom.co/v1/datasets/synthetic/ingest"},
		{"https://us-east-1.aws.edge.axiom.co", "https://us-east-1.aws.edge.axiom.co/v1/ingest/synthetic"},
	} {
		sink, err := NewAxiomEvidence(test.endpoint, "Authorization=Bearer%20synthetic,x-axiom-dataset=synthetic")
		if err != nil || sink.ingestURL != test.want {
			t.Errorf("endpoint = %s, ingest URL = %s, error = %v; want %s", test.endpoint, sink.ingestURL, err, test.want)
		}
	}
}

func TestAxiomEvidenceDoesNotAllocateColumnsForRecordFields(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var rows []struct {
			Body       string            `json:"body"`
			Attributes map[string]string `json:"attributes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&rows); err != nil || len(rows) != 1 {
			t.Errorf("invalid evidence wire payload: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		row := rows[0]
		if len(row.Attributes) != 1 || row.Attributes["episode_id"] != "synthetic" || !strings.Contains(row.Body, `"new_fact_field":"retained"`) {
			t.Error("want only the Episode index in columns and the fact field in the evidence body")
		}
		_, _ = w.Write([]byte(`{"ingested":1,"failed":0}`))
	}))
	defer server.Close()
	sink, err := NewAxiomEvidence(server.URL, "Authorization=Bearer%20synthetic,x-axiom-dataset=synthetic")
	if err != nil {
		t.Fatal(err)
	}
	row := json.RawMessage(`{"service":{"name":"chalk-sync"},"attributes":{"episode_id":"synthetic","new_fact_field":"retained"}}`)
	if err := sink.Export(t.Context(), []json.RawMessage{row}); err != nil {
		t.Fatal(err)
	}
}

func TestAxiomEvidenceIndexesTheDiagnosisFieldsAndKeepsTheWholeRowInTheBody(t *testing.T) {
	row := json.RawMessage(`{"service":{"name":"chalk-api"},"attributes":{"episode_id":"e","type":"media_state","phase":"connected","ice_state":"checking","network_type":"wifi","http_status":400,"media_error_kind":"SFUError","relay_protocol":"udp"}}`)
	payload, err := axiomEvidencePayload([]json.RawMessage{row})
	if err != nil {
		t.Fatal(err)
	}
	var wire []struct {
		Body       string                     `json:"body"`
		Attributes map[string]json.RawMessage `json:"attributes"`
	}
	if err := json.Unmarshal(payload, &wire); err != nil || len(wire) != 1 {
		t.Fatalf("payload %s: %v", payload, err)
	}
	for key, want := range map[string]string{"type": `"media_state"`, "phase": `"connected"`, "ice_state": `"checking"`, "network_type": `"wifi"`, "http_status": `400`, "media_error_kind": `"SFUError"`} {
		if got := string(wire[0].Attributes[key]); got != want {
			t.Errorf("column %s = %s, want %s", key, got, want)
		}
	}
	if _, indexed := wire[0].Attributes["relay_protocol"]; indexed {
		t.Error("a field outside the diagnosis set became a column")
	}
	if !strings.Contains(wire[0].Body, `"relay_protocol":"udp"`) {
		t.Error("the body no longer carries the whole row")
	}
}
