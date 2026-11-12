package media

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
)

// maxOperationRecords bounds a session's replay table. The API adapter retries within seconds,
// so the oldest record is the safest to forget when a long call fills the table.
const maxOperationRecords = 256

type operationRecord struct {
	digest   [sha256.Size]byte
	response json.RawMessage
}

// replayTable remembers each successful mutation by operation ID, so a retry whose first
// attempt succeeded returns that result instead of repeating the side effect. A failed attempt
// leaves no record, so a retry runs again. Reusing an ID for a different body is a conflict.
// The caller holds the session's opMu.
type replayTable struct {
	records map[string]operationRecord
	order   []string
}

func (t *replayTable) lookup(operationID string, request any) (json.RawMessage, bool, error) {
	record, ok := t.records[operationID]
	if !ok {
		return nil, false, nil
	}
	digest, err := digestOf(request)
	if err != nil {
		return nil, false, err
	}
	if digest != record.digest {
		return nil, false, ErrOperationConflict
	}
	return record.response, true, nil
}

func (t *replayTable) remember(operationID string, request any, response any) error {
	digest, err := digestOf(request)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		return fmt.Errorf("encode response for replay: %w", err)
	}
	if t.records == nil {
		t.records = map[string]operationRecord{}
	}
	if len(t.order) >= maxOperationRecords {
		delete(t.records, t.order[0])
		t.order = t.order[1:]
	}
	t.records[operationID] = operationRecord{digest: digest, response: encoded}
	t.order = append(t.order, operationID)
	return nil
}

func digestOf(request any) ([sha256.Size]byte, error) {
	encoded, err := json.Marshal(request)
	if err != nil {
		return [sha256.Size]byte{}, fmt.Errorf("encode request for replay: %w", err)
	}
	return sha256.Sum256(encoded), nil
}

// once runs a session mutation at most once per operation ID. The caller holds s.opMu.
func once[T any](s *Session, operationID string, request any, run func() (T, error)) (T, error) {
	var zero T
	if err := checkIdentifier("operationId", operationID); err != nil {
		return zero, err
	}
	if s.isClosed() {
		return zero, ErrSessionGone
	}
	if encoded, replayed, err := s.ops.lookup(operationID, request); err != nil || replayed {
		if err != nil {
			return zero, err
		}
		var response T
		if err := json.Unmarshal(encoded, &response); err != nil {
			return zero, fmt.Errorf("decode replayed response: %w", err)
		}
		return response, nil
	}
	response, err := run()
	if err != nil {
		return zero, err
	}
	if err := s.ops.remember(operationID, request, response); err != nil {
		return zero, err
	}
	return response, nil
}
