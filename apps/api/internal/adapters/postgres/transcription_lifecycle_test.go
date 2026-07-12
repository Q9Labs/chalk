package postgres

import (
	"os"
	"strings"
	"testing"
)

func TestTranscriptionLifecycleSQLFencesReadinessAndTerminalProjection(t *testing.T) {
	transcriptionsSQL, err := os.ReadFile("../../../db/queries/transcriptions.sql")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(transcriptionsSQL), "-- name: LockTenantTranscriptionForUpdate :one") {
		t.Fatal("chunk completion must lock the transcript row before finalizer readiness checks")
	}
	artifactJobsSQL, err := os.ReadFile("../../../db/queries/artifact_jobs.sql")
	if err != nil {
		t.Fatal(err)
	}
	contents := string(artifactJobsSQL)
	for _, marker := range []string{
		"-- name: CreateTranscriptionFinalizerJobIfReady :one",
		"bool_or(state = 'dead_letter')",
		"then 'terminal_failure'",
		"state = 'cancelled'",
	} {
		if !strings.Contains(contents, marker) {
			t.Fatalf("artifact lifecycle SQL missing %q", marker)
		}
	}
}
