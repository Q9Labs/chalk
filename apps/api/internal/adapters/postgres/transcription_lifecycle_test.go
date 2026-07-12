package postgres

import (
	"os"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
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
	for _, query := range []string{"ClaimArtifactJob", "ClaimTranscriptionFinalizerJob"} {
		section := querySection(contents, query)
		for _, marker := range []string{"state = 'leased'", "lease_expires_at <= sqlc.arg(now)::timestamptz", "attempt_count < attempt_limit"} {
			if !strings.Contains(section, marker) {
				t.Fatalf("%s SQL missing expired-lease reclaim marker %q", query, marker)
			}
		}
		terminalMarker := "worker lease expired at attempt limit"
		if query == "ClaimTranscriptionFinalizerJob" {
			terminalMarker = "finalizer lease expired at attempt limit"
		}
		if !strings.Contains(section, terminalMarker) {
			t.Fatalf("%s SQL missing terminal expired-lease marker %q", query, terminalMarker)
		}
	}
	cleanupSQL, err := os.ReadFile("../../../db/queries/transcription_cleanup_jobs.sql")
	if err != nil {
		t.Fatal(err)
	}
	cleanupSection := querySection(string(cleanupSQL), "ClaimTranscriptionCleanupJob")
	for _, marker := range []string{"cleanup lease expired at attempt limit", "state = 'leased'", "lease_expires_at <= sqlc.arg(now)::timestamptz", "attempt_count < attempt_limit"} {
		if !strings.Contains(cleanupSection, marker) {
			t.Fatalf("cleanup lifecycle SQL missing %q", marker)
		}
	}
}

func TestSourceSeedSQLReplacesTheCompleteChunkSet(t *testing.T) {
	contents, err := os.ReadFile("../../../db/queries/transcription_sources.sql")
	if err != nil {
		t.Fatal(err)
	}
	query := string(contents)
	if !strings.Contains(query, "-- name: DeleteRecordingTranscriptionSourceChunks :exec") {
		t.Fatal("source seeding must delete the prior chunk set in the same transaction")
	}
	if !strings.Contains(query, "delete from recording_transcription_source_chunks\nwhere recording_id = $1") {
		t.Fatal("source chunk replacement must remove every generation for the recording")
	}
}

func querySection(contents, name string) string {
	start := strings.Index(contents, "-- name: "+name+" ")
	if start < 0 {
		return ""
	}
	end := strings.Index(contents[start+1:], "\n-- name: ")
	if end < 0 {
		return contents[start:]
	}
	return contents[start : start+1+end]
}

func TestFinalizerCleanupArtifactsExcludeRecorderSourceChunks(t *testing.T) {
	tenantID, err := utilities.ParseID("00000000-0000-4000-8000-000000000001")
	if err != nil {
		t.Fatal(err)
	}
	transcriptID, err := utilities.ParseID("00000000-0000-4000-8000-000000000002")
	if err != nil {
		t.Fatal(err)
	}
	chunkID, err := utilities.ParseID("00000000-0000-4000-8000-000000000003")
	if err != nil {
		t.Fatal(err)
	}
	artifacts := finalizerCleanupArtifacts(tenantID, transcriptID, []sqlc.TranscriptChunk{{ID: uuid(chunkID), Generation: 1, ChunkIndex: 7, StorageKey: "recording/source.wav", ResultKey: "legacy/result.json"}}, []sqlc.ArtifactJob{{ChunkID: uuid(chunkID), AttemptCount: 2}})
	want := []string{
		chunkResultKey(tenantID, transcriptID, 1, 7, 1),
		chunkResultKey(tenantID, transcriptID, 1, 7, 2),
	}
	if len(artifacts) != len(want) {
		t.Fatalf("finalizer cleanup artifacts = %#v; want both attempt destinations", artifacts)
	}
	for i, artifact := range artifacts {
		if artifact.key != want[i] || artifact.kind != "temp_result" {
			t.Fatalf("finalizer cleanup artifact[%d] = %#v; want key %q and temp_result", i, artifact, want[i])
		}
		if artifact.key == "recording/source.wav" {
			t.Fatal("recorder-owned source must not be enqueued")
		}
	}
}

func TestAttemptQualifiedArtifactKeysAreDistinct(t *testing.T) {
	tenantID, _ := utilities.ParseID("00000000-0000-4000-8000-000000000001")
	transcriptID, _ := utilities.ParseID("00000000-0000-4000-8000-000000000002")
	if first, second := chunkResultKey(tenantID, transcriptID, 1, 7, 1), chunkResultKey(tenantID, transcriptID, 1, 7, 2); first == second {
		t.Fatalf("chunk result key reused across attempts: %q", first)
	}
	if first, second := finalArtifactKey(tenantID, transcriptID, 1), finalArtifactKey(tenantID, transcriptID, 2); first == second {
		t.Fatalf("final artifact key reused across attempts: %q", first)
	}
	previous := finalizerPreviousCleanupArtifacts(tenantID, transcriptID, 2)
	if len(previous) != 1 || previous[0].key != finalArtifactKey(tenantID, transcriptID, 1) || previous[0].kind != "final_artifact" {
		t.Fatalf("prior finalizer cleanup = %#v; want only attempt 1", previous)
	}
}
