package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
