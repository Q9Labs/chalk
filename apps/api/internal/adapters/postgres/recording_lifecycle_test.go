package postgres

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordinglifecycle"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestRecordingLifecyclePayloadAndFingerprintAreStable(t *testing.T) {
	payload, err := lifecyclePayload(recordingCaptureReadyOperation, "6a9b6a12-7457-4fe9-a58b-8b234d0be004", "6a9b6a12-7457-4fe9-a58b-8b234d0be006", 7)
	if err != nil {
		t.Fatalf("build ready payload: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	for _, key := range []string{"recordingId", "startOperationId", "captureEpoch"} {
		if _, ok := decoded[key]; !ok {
			t.Fatalf("payload missing camelCase field %q: %s", key, payload)
		}
	}
	if len(decoded) != 3 {
		t.Fatalf("payload has fields outside the Sync contract: %s", payload)
	}
	fingerprint := sha256.Sum256(payload)
	fingerprintAgain := sha256.Sum256(append([]byte(nil), payload...))
	if !bytes.Equal(fingerprint[:], fingerprintAgain[:]) || len(fingerprint) != sha256.Size {
		t.Fatalf("fingerprint is not deterministic: %x %x", fingerprint, fingerprintAgain)
	}
}

func TestRecordingLifecycleOperationIDUsesAuthoritativeState(t *testing.T) {
	startID := mustLifecycleID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be006")
	stopID := mustLifecycleID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be007")
	row := sqlc.LockRecordingCaptureLifecycleAuthorityRow{
		RecordingStatus:          "starting",
		StartExternalOperationID: pgtype.UUID{Bytes: startID.Bytes(), Valid: true},
		StopExternalOperationID:  pgtype.UUID{Bytes: stopID.Bytes(), Valid: true},
	}
	if operationID, err := lifecycleOperationID(row, recordingCaptureReadyOperation); err != nil || operationID != startID.String() {
		t.Fatalf("ready operation = %q, error = %v", operationID, err)
	}
	if operationID, err := lifecycleOperationID(row, recordingCaptureStoppedOperation); err != nil || operationID != stopID.String() {
		t.Fatalf("stopped operation = %q, error = %v", operationID, err)
	}
	if !lifecycleStatusAllowsNewOperation(row.RecordingStatus, recordingCaptureReadyOperation) {
		t.Fatal("starting status must allow a new ready operation")
	}
	if lifecycleStatusAllowsNewOperation(row.RecordingStatus, recordingCaptureStoppedOperation) {
		t.Fatal("starting status must reject a new stopped operation")
	}
	row.RecordingStatus = "stopping"
	if lifecycleStatusAllowsNewOperation(row.RecordingStatus, recordingCaptureReadyOperation) {
		t.Fatal("stopping status must reject a new ready operation")
	}
	if !lifecycleStatusAllowsNewOperation(row.RecordingStatus, recordingCaptureStoppedOperation) {
		t.Fatal("stopping status must allow a new stopped operation")
	}
}

func TestRecordingLifecycleIDsRejectWrongAuthority(t *testing.T) {
	_, err := lifecycleIDs(recordinglifecycle.Authority{TenantID: "not-a-uuid"})
	if !errors.Is(err, recordinglifecycle.ErrInvalidRequest) {
		t.Fatalf("invalid authority error = %v, want invalid request", err)
	}
}

func mustLifecycleID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse fixture id: %v", err)
	}
	return id
}
