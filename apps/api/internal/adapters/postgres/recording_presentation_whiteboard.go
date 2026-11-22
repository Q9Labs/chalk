package postgres

import (
	"encoding/json"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

type completionWhiteboardEventWire struct {
	Name        string            `json:"operation_name"`
	OperationID string            `json:"operation_id"`
	SceneID     string            `json:"scene_id"`
	Revision    int64             `json:"revision"`
	Elements    []json.RawMessage `json:"elements"`
	Presenting  *bool             `json:"presenting"`
	CompletedAt time.Time         `json:"completed_at"`
}

type completionWhiteboardFileWire struct {
	SceneID    string `json:"scene_id"`
	ID         string `json:"file_id"`
	ObjectKey  string `json:"object_key"`
	ObjectETag string `json:"object_etag"`
	MIMEType   string `json:"mime_type"`
	ByteLength int64  `json:"byte_length"`
	SHA256     string `json:"sha256"`
}

func mapWhiteboardEventFacts(values []completionWhiteboardEventWire) []recordingpresentation.WhiteboardEventFact {
	result := make([]recordingpresentation.WhiteboardEventFact, 0, len(values))
	for _, value := range values {
		result = append(result, recordingpresentation.WhiteboardEventFact{
			OperationID: value.OperationID, Name: value.Name, SceneID: value.SceneID,
			Revision: value.Revision, Elements: cloneRawMessages(value.Elements),
			Presenting: cloneBool(value.Presenting), CompletedAt: value.CompletedAt,
		})
	}
	return result
}

func mapWhiteboardFileFacts(values []completionWhiteboardFileWire) ([]recordingpresentation.WhiteboardFileFact, error) {
	result := make([]recordingpresentation.WhiteboardFileFact, 0, len(values))
	for _, value := range values {
		object, err := completionObjectFact(value.ObjectKey, value.ObjectETag, value.MIMEType, value.ByteLength, value.SHA256)
		if err != nil {
			return nil, err
		}
		result = append(result, recordingpresentation.WhiteboardFileFact{SceneID: value.SceneID, ID: value.ID, Object: object})
	}
	return result, nil
}

func cloneBool(value *bool) *bool {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
