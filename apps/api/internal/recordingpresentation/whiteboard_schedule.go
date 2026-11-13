package recordingpresentation

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"
)

type whiteboardUpdateWire struct {
	Revision int64                   `json:"revision"`
	Elements []whiteboardElementWire `json:"elements"`
}

type whiteboardHistoryWire struct {
	SchemaVersion string                 `json:"schemaVersion"`
	Initial       whiteboardStateWire    `json:"initial"`
	Updates       []whiteboardUpdateWire `json:"updates"`
}

func scheduleWhiteboardTail(source CompletionSource, state *whiteboardState, _ map[string]activeTrack, materials *[]assetMaterial, assetByID map[string]int, appendEvent func(int64, int, Event)) (int64, error) {
	cursor := source.WhiteboardOriginRevision
	if len(source.WhiteboardTailEvents) == 0 {
		return cursor, nil
	}
	histories := make(map[string]*whiteboardHistoryWire)
	replayed := make(map[string]bool)
	assetIDs := make(map[string]string)
	for _, material := range *materials {
		if material.Asset.Kind != "whiteboard_state" {
			continue
		}
		var initial whiteboardStateWire
		if err := json.Unmarshal(material.Body, &initial); err != nil {
			return 0, err
		}
		assetIDs[initial.SceneID] = material.Asset.ID
		histories[material.Asset.ID] = &whiteboardHistoryWire{SchemaVersion: "recording_whiteboard_history.v1", Initial: initial, Updates: []whiteboardUpdateWire{}}
	}
	for _, fact := range source.WhiteboardTailEvents {
		at, err := elapsedMillis(source, fact.CompletedAt)
		if err != nil {
			return 0, err
		}
		changes := make([]whiteboardElementWire, 0, len(fact.Elements))
		var changeByID map[string]int
		if len(fact.Elements) > 1 {
			changeByID = make(map[string]int, len(fact.Elements))
		}
		for _, raw := range fact.Elements {
			element, decodeErr := decodeWhiteboardElement(raw)
			if decodeErr != nil {
				return 0, decodeErr
			}
			if index, exists := changeByID[element.ID]; exists {
				if whiteboardElementWins(element, changes[index]) {
					changes[index] = element
				}
				continue
			}
			if state == nil {
				changes = append(changes, element)
			} else if existing, exists := state.Elements[element.ID]; !exists || whiteboardElementWins(element, existing) {
				changes = append(changes, element)
			} else {
				continue
			}
			if changeByID != nil {
				changeByID[element.ID] = len(changes) - 1
			}
		}
		before := state
		state, err = applyWhiteboardFact(state, fact)
		if err != nil {
			return 0, err
		}
		if fact.Revision > cursor {
			cursor = fact.Revision
		}
		if state == before || state == nil {
			continue
		}
		assetID := assetIDs[state.SceneID]
		if assetID != "" && len(changes) > 0 {
			if err := validateWhiteboardFileReferences(changes, assetByID); err != nil {
				return 0, err
			}
			histories[assetID].Updates = append(histories[assetID].Updates, whiteboardUpdateWire{Revision: state.Revision, Elements: changes})
		}
		if state.Presenting {
			if assetID == "" {
				assetID, err = addWhiteboardStateAsset(*state, source, materials, assetByID)
				if err != nil {
					return 0, err
				}
				var initial whiteboardStateWire
				if err := json.Unmarshal((*materials)[assetByID[assetID]].Body, &initial); err != nil {
					return 0, err
				}
				assetIDs[state.SceneID] = assetID
				histories[assetID] = &whiteboardHistoryWire{SchemaVersion: "recording_whiteboard_history.v1", Initial: initial, Updates: []whiteboardUpdateWire{}}
			}
			appendEvent(at, 42, &SharedContentChangedEvent{Kind: "shared_content_changed", SharedContent: SharedContent{
				Kind: "whiteboard", SceneID: state.SceneID, Revision: state.Revision, StateAssetID: assetID,
			}})
			replayed[assetID] = state.Revision != histories[assetID].Initial.Revision
		} else if before != nil && before.Presenting {
			fallback, err := screenSharedAt(source, fact.CompletedAt)
			if err != nil {
				return 0, err
			}
			appendEvent(at, 42, &SharedContentChangedEvent{Kind: "shared_content_changed", SharedContent: fallback})
		}
	}
	for assetID, history := range histories {
		if len(history.Updates) == 0 && !replayed[assetID] {
			continue
		} // Preserve the original format for static states.
		body, err := json.Marshal(history)
		if err != nil {
			return 0, fmt.Errorf("%w: encode whiteboard history", ErrInvalidCompletionSource)
		}
		if len(body) > MaximumTimelineSize {
			return 0, fmt.Errorf("%w: whiteboard history exceeds bounds", ErrInvalidCompletionSource)
		}
		digest := sha256.Sum256(body)
		digestHex := hex.EncodeToString(digest[:])
		material := &(*materials)[assetByID[assetID]]
		material.Body = body
		material.Asset.ByteSize = int64(len(body))
		material.Asset.SHA256 = digestHex
		material.Asset.ObjectKey = presentationObjectPrefix(source) + "/assets/whiteboard-state-" + digestHex + ".json"
	}
	return cursor, nil
}

func whiteboardPresentedAt(source CompletionSource, at time.Time) bool {
	state, err := whiteboardAtOrigin(source)
	if err != nil {
		return false
	}
	if at.Before(source.CaptureReadyAt) {
		return state != nil && state.Presenting
	}
	for _, fact := range source.WhiteboardTailEvents {
		if fact.CompletedAt.After(at) {
			break
		}
		state, err = applyWhiteboardFact(state, fact)
		if err != nil {
			return false
		}
	}
	return state != nil && state.Presenting
}
