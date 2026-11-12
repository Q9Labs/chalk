package postgres

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordinglifecycle"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type lifecycleIDSet struct {
	tenantID    pgtype.UUID
	spaceID     pgtype.UUID
	episodeID   pgtype.UUID
	recordingID pgtype.UUID
	jobID       pgtype.UUID
}

func lifecycleIDs(authority recordinglifecycle.Authority) (lifecycleIDSet, error) {
	values := []struct {
		name  string
		value string
		set   *pgtype.UUID
	}{
		{name: "tenant_id", value: authority.TenantID, set: new(pgtype.UUID)},
		{name: "space_id", value: authority.SpaceID, set: new(pgtype.UUID)},
		{name: "episode_id", value: authority.EpisodeID, set: new(pgtype.UUID)},
		{name: "recording_id", value: authority.RecordingID, set: new(pgtype.UUID)},
		{name: "job_id", value: authority.JobID, set: new(pgtype.UUID)},
	}
	for _, item := range values {
		parsed, err := utilities.ParseID(item.value)
		if err != nil {
			return lifecycleIDSet{}, fmt.Errorf("%w: %s", recordinglifecycle.ErrInvalidRequest, item.name)
		}
		*item.set = uuid(parsed)
	}
	return lifecycleIDSet{tenantID: *values[0].set, spaceID: *values[1].set, episodeID: *values[2].set, recordingID: *values[3].set, jobID: *values[4].set}, nil
}

func lifecycleOperationID(row sqlc.LockRecordingCaptureLifecycleAuthorityRow, operationName string) (string, error) {
	if operationName == recordingCaptureReadyOperation {
		if !row.StartExternalOperationID.Valid {
			return "", recordinglifecycle.ErrAuthorityMismatch
		}
		return utilities.IDFromBytes(row.StartExternalOperationID.Bytes).String(), nil
	}
	if !row.StopExternalOperationID.Valid {
		return "", recordinglifecycle.ErrAuthorityMismatch
	}
	return utilities.IDFromBytes(row.StopExternalOperationID.Bytes).String(), nil
}

func lifecycleStatusAllowsNewOperation(recordingStatus, operationName string) bool {
	if operationName == recordingCaptureReadyOperation {
		return recordingStatus == "starting"
	}
	return recordingStatus == "stopping"
}

type readyPayload struct {
	RecordingID      string `json:"recordingId"`
	StartOperationID string `json:"startOperationId"`
	CaptureEpoch     int64  `json:"captureEpoch"`
}

type stoppedPayload struct {
	RecordingID     string `json:"recordingId"`
	StopOperationID string `json:"stopOperationId"`
	CaptureEpoch    int64  `json:"captureEpoch"`
}

type deadlineStoppedPayload struct {
	RecordingID      string `json:"recordingId"`
	DeadlineAtMillis int64  `json:"deadlineAtMs"`
	CaptureEpoch     int64  `json:"captureEpoch"`
}

func lifecyclePayload(operationName, recordingID, operationID string, captureEpoch int64) ([]byte, error) {
	var payload any
	if operationName == recordingCaptureReadyOperation {
		payload = readyPayload{RecordingID: recordingID, StartOperationID: operationID, CaptureEpoch: captureEpoch}
	} else {
		payload = stoppedPayload{RecordingID: recordingID, StopOperationID: operationID, CaptureEpoch: captureEpoch}
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal recording capture lifecycle payload: %w", err)
	}
	return encoded, nil
}

func lifecycleRequestFingerprint(payload []byte, occurredAt time.Time, noPublisher bool) [sha256.Size]byte {
	digest := sha256.New()
	_, _ = digest.Write(payload)
	_, _ = digest.Write([]byte{0})
	_, _ = digest.Write([]byte(occurredAt.UTC().Format(time.RFC3339Nano)))
	if noPublisher {
		_, _ = digest.Write([]byte{1})
	} else {
		_, _ = digest.Write([]byte{0})
	}
	var result [sha256.Size]byte
	copy(result[:], digest.Sum(nil))
	return result
}

func mapRecordingLifecyclePublication(operation sqlc.SyncExternalOperation) (recordinglifecycle.Publication, error) {
	if !operation.ExternalOperationID.Valid {
		return recordinglifecycle.Publication{}, recordinglifecycle.ErrOperationConflict
	}
	return recordinglifecycle.Publication{
		ExternalOperationID: utilities.IDFromBytes(operation.ExternalOperationID.Bytes).String(),
		OperationName:       operation.OperationName,
		RequestKey:          operation.RequestKey,
		RequestFingerprint:  append([]byte(nil), operation.RequestFingerprint...),
		Payload:             append([]byte(nil), operation.Payload...),
	}, nil
}
