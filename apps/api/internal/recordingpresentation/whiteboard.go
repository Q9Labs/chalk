package recordingpresentation

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
)

const whiteboardStateSchemaVersion = "recording_whiteboard_state.v1"

type whiteboardElementWire struct {
	ID           string          `json:"id"`
	Type         string          `json:"type"`
	Version      int64           `json:"version"`
	VersionNonce int64           `json:"version_nonce"`
	Index        string          `json:"index"`
	Deleted      bool            `json:"is_deleted"`
	Payload      json.RawMessage `json:"payload"`
}

type whiteboardState struct {
	SceneID    string
	Revision   int64
	Presenting bool
	AppState   json.RawMessage
	Elements   map[string]whiteboardElementWire
}

type whiteboardStateWire struct {
	SchemaVersion string                  `json:"schemaVersion"`
	SceneID       string                  `json:"sceneId"`
	Revision      int64                   `json:"revision"`
	AppState      json.RawMessage         `json:"appState"`
	Elements      []whiteboardElementWire `json:"elements"`
}

func whiteboardAtOrigin(source CompletionSource) (*whiteboardState, error) {
	state, err := newWhiteboardState(source.InitialWhiteboard)
	if err != nil {
		return nil, err
	}
	cursor := source.WhiteboardStartRevision
	for _, fact := range source.WhiteboardOriginEvents {
		if fact.CompletedAt.After(source.CaptureReadyAt) {
			return nil, fmt.Errorf("%w: whiteboard origin event after origin", ErrInvalidCompletionSource)
		}
		state, err = applyWhiteboardFact(state, fact)
		if err != nil {
			return nil, err
		}
		if fact.Revision > cursor {
			cursor = fact.Revision
		}
	}
	if cursor != source.WhiteboardOriginRevision {
		return nil, fmt.Errorf("%w: whiteboard origin cursor mismatch", ErrInvalidCompletionSource)
	}
	return state, nil
}

func newWhiteboardState(snapshot *WhiteboardSnapshotFact) (*whiteboardState, error) {
	if snapshot == nil {
		return nil, nil
	}
	if snapshot.SceneID == "" || snapshot.Revision < 0 || len(snapshot.AppState) == 0 {
		return nil, fmt.Errorf("%w: invalid whiteboard snapshot", ErrInvalidCompletionSource)
	}
	appState := append(json.RawMessage(nil), snapshot.AppState...)
	// A scene that never set shared app state is stored as SQL NULL; the Render accepts only an object.
	if bytes.Equal(bytes.TrimSpace(appState), []byte("null")) {
		appState = json.RawMessage(`{}`)
	}
	state := &whiteboardState{
		SceneID: snapshot.SceneID, Revision: snapshot.Revision, Presenting: snapshot.Presenting,
		AppState: appState, Elements: make(map[string]whiteboardElementWire, len(snapshot.Elements)),
	}
	for _, raw := range snapshot.Elements {
		element, err := decodeWhiteboardElement(raw)
		if err != nil {
			return nil, err
		}
		if _, exists := state.Elements[element.ID]; exists {
			return nil, fmt.Errorf("%w: duplicate whiteboard element", ErrInvalidCompletionSource)
		}
		state.Elements[element.ID] = element
	}
	return state, nil
}

func applyWhiteboardFact(state *whiteboardState, fact WhiteboardEventFact) (*whiteboardState, error) {
	if fact.OperationID == "" || fact.SceneID == "" || fact.Revision < 0 || fact.CompletedAt.IsZero() {
		return nil, fmt.Errorf("%w: invalid whiteboard event", ErrInvalidCompletionSource)
	}
	switch fact.Name {
	case "clear":
		presenting := false
		if state != nil {
			presenting = state.Presenting
		}
		if fact.Revision != 0 || len(fact.Elements) != 0 || fact.Presenting != nil {
			return nil, fmt.Errorf("%w: invalid whiteboard clear", ErrInvalidCompletionSource)
		}
		return &whiteboardState{SceneID: fact.SceneID, Revision: 0, Presenting: presenting, AppState: json.RawMessage(`{}`), Elements: make(map[string]whiteboardElementWire)}, nil
	case "set_draw_permission":
		if len(fact.Elements) != 0 || fact.Presenting != nil {
			return nil, fmt.Errorf("%w: invalid whiteboard permission event", ErrInvalidCompletionSource)
		}
		return state, nil
	case "submit_update", "set_presentation":
		if state == nil {
			if fact.Revision != 1 {
				return nil, fmt.Errorf("%w: missing whiteboard state", ErrInvalidCompletionSource)
			}
			state = &whiteboardState{SceneID: fact.SceneID, Revision: 0, AppState: json.RawMessage(`{}`), Elements: make(map[string]whiteboardElementWire)}
		}
		if state.SceneID != fact.SceneID || fact.Revision != state.Revision+1 {
			return nil, fmt.Errorf("%w: whiteboard revision gap", ErrInvalidCompletionSource)
		}
		// Replay owns this map; only the scalar presentation state needs a copy.
		nextValue := *state
		next := &nextValue
		next.Revision = fact.Revision
		if fact.Name == "set_presentation" {
			if fact.Presenting == nil || len(fact.Elements) != 0 {
				return nil, fmt.Errorf("%w: invalid whiteboard presentation event", ErrInvalidCompletionSource)
			}
			next.Presenting = *fact.Presenting
			return next, nil
		}
		if fact.Presenting != nil {
			return nil, fmt.Errorf("%w: invalid whiteboard update event", ErrInvalidCompletionSource)
		}
		changed := false
		for _, raw := range fact.Elements {
			element, err := decodeWhiteboardElement(raw)
			if err != nil {
				return nil, err
			}
			if existing, exists := next.Elements[element.ID]; !exists || whiteboardElementWins(element, existing) {
				next.Elements[element.ID] = element
				changed = true
			}
		}
		if !changed {
			state.Revision = fact.Revision
			return state, nil
		}
		return next, nil
	default:
		return nil, fmt.Errorf("%w: unknown whiteboard operation", ErrInvalidCompletionSource)
	}
}

func decodeWhiteboardElement(raw json.RawMessage) (whiteboardElementWire, error) {
	var element whiteboardElementWire
	if err := json.Unmarshal(raw, &element); err != nil || element.ID == "" || element.Type == "" ||
		element.Version < 0 || element.VersionNonce < 0 || element.Index == "" || len(element.Payload) == 0 {
		return whiteboardElementWire{}, fmt.Errorf("%w: invalid whiteboard element", ErrInvalidCompletionSource)
	}
	return element, nil
}

func whiteboardElementWins(candidate, existing whiteboardElementWire) bool {
	return candidate.Version > existing.Version || (candidate.Version == existing.Version && candidate.VersionNonce < existing.VersionNonce)
}

func addWhiteboardStateAsset(state whiteboardState, source CompletionSource, materials *[]assetMaterial, assetByID map[string]int) (string, error) {
	elements := make([]whiteboardElementWire, 0, len(state.Elements))
	for _, element := range state.Elements {
		elements = append(elements, element)
	}
	sort.Slice(elements, func(i, j int) bool {
		if elements[i].Index != elements[j].Index {
			return elements[i].Index < elements[j].Index
		}
		return elements[i].ID < elements[j].ID
	})
	if err := validateWhiteboardFileReferences(elements, assetByID); err != nil {
		return "", err
	}
	body, err := json.Marshal(whiteboardStateWire{
		SchemaVersion: whiteboardStateSchemaVersion, SceneID: state.SceneID,
		Revision: state.Revision, AppState: state.AppState, Elements: elements,
	})
	if err != nil {
		return "", fmt.Errorf("%w: encode whiteboard state", ErrInvalidCompletionSource)
	}
	digest := sha256.Sum256(body)
	digestHex := hex.EncodeToString(digest[:])
	assetID := fmt.Sprintf("whiteboard_state:%s:%d", state.SceneID, state.Revision)
	asset := Asset{
		ID: assetID, Kind: "whiteboard_state",
		ObjectKey:   presentationObjectPrefix(source) + "/assets/whiteboard-state-" + digestHex + ".json",
		ContentType: "application/json", ByteSize: int64(len(body)), SHA256: digestHex,
	}
	if err := addAssetMaterial(assetMaterial{Asset: asset, Body: body}, materials, assetByID); err != nil {
		return "", err
	}
	return assetID, nil
}

func addWhiteboardFileAssets(source CompletionSource, materials *[]assetMaterial, assetByID map[string]int) error {
	for _, file := range source.WhiteboardFiles {
		assetID := "whiteboard_file:" + file.ID
		digest := hex.EncodeToString(file.Object.SHA256)
		asset := Asset{
			ID: assetID, Kind: "whiteboard_file",
			ObjectKey:   existingAssetObjectKey(source, assetID, "whiteboard_file", digest),
			ContentType: file.Object.ContentType, ByteSize: file.Object.ByteSize,
			SHA256: digest,
		}
		if err := addAssetMaterial(assetMaterial{Asset: asset, Existing: cloneObjectFactPointer(file.Object)}, materials, assetByID); err != nil {
			return err
		}
	}
	return nil
}

func validateWhiteboardFileReferences(elements []whiteboardElementWire, assetByID map[string]int) error {
	for _, element := range elements {
		if element.Deleted {
			continue
		}
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(element.Payload, &payload); err != nil {
			return fmt.Errorf("%w: invalid whiteboard element payload", ErrInvalidCompletionSource)
		}
		raw, exists := payload["fileId"]
		if !exists || bytes.Equal(raw, []byte("null")) {
			continue
		}
		var fileID string
		if err := json.Unmarshal(raw, &fileID); err != nil || fileID == "" {
			return fmt.Errorf("%w: invalid whiteboard file identity", ErrInvalidCompletionSource)
		}
		if _, exists := assetByID["whiteboard_file:"+fileID]; !exists {
			return fmt.Errorf("%w: missing whiteboard file asset", ErrInvalidCompletionSource)
		}
	}
	return nil
}
