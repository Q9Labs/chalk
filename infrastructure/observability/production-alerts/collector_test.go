package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"text/template"
)

func TestIngestRejectsPartialAcceptanceWithoutLeakingResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ingested":1,"failed":1,"failures":["private-test-payload"]}`))
	}))
	defer server.Close()
	err := ingest(context.Background(), server.Client(), server.URL, "private-test-token", []snapshot{{Rule: "recording"}, {Rule: "export"}})
	if err == nil || strings.Contains(err.Error(), "private-test") {
		t.Fatalf("partial ingest must fail with a redacted error: %v", err)
	}
}

func TestIngestRejectsUnexpectedSuccessBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{}`))
	}))
	defer server.Close()
	if err := ingest(context.Background(), server.Client(), server.URL, "test", []snapshot{{Rule: "recording"}}); err == nil {
		t.Fatal("a 200 without acceptance evidence must not count as delivery")
	}
}

func TestDiscordTemplateProducesPlainMessagesAndHonestClosure(t *testing.T) {
	body, err := os.ReadFile("discord-body.tmpl")
	if err != nil {
		t.Fatal(err)
	}
	tmpl, err := template.New("discord").Parse(string(body))
	if err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"Open", "Closed"} {
		headline, summary, next := message("export")
		var output bytes.Buffer
		data := map[string]interface{}{"Action": action, "Title": "internal title", "Description": "internal description", "Value": 2, "GroupKeys": []string{"summary", "rule", "headline", "next", "engineers"}, "GroupValues": []string{summary, "export", headline, next, "For engineers: export; trace command."}}
		if err := tmpl.Execute(&output, data); err != nil {
			t.Fatal(err)
		}
		var payload struct {
			Content         string `json:"content"`
			AllowedMentions struct {
				Parse []string `json:"parse"`
			} `json:"allowed_mentions"`
		}
		if err := json.Unmarshal(output.Bytes(), &payload); err != nil {
			t.Fatalf("invalid Discord JSON: %v", err)
		}
		if len(payload.AllowedMentions.Parse) != 0 {
			t.Fatal("mentions must be disabled")
		}
		if action == "Open" && (!strings.HasPrefix(payload.Content, headline+"\n") || !strings.Contains(payload.Content, "Affected items: 2.")) {
			t.Fatal(payload.Content)
		}
		if action == "Closed" && (!strings.Contains(payload.Content, "does not prove") || strings.Contains(payload.Content, "Resolved")) {
			t.Fatal(payload.Content)
		}
	}
}
