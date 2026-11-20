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
