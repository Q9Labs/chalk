package websocket

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

type persistedWhiteboardStateV2 struct {
	SchemaVersion int               `json:"schemaVersion"`
	SceneID       string            `json:"sceneId"`
	Elements      []json.RawMessage `json:"elements"`
	UpdatedAtMs   int64             `json:"updatedAtMs"`
	LastSeq       int64             `json:"lastSeq"`
}

// v1 persisted format (legacy). Restore-only.
type persistedWhiteboardStateV1 struct {
	Elements json.RawMessage `json:"elements"`
	Files    json.RawMessage `json:"files"`
	AppState json.RawMessage `json:"appState"`
	LastSeq  int64           `json:"lastSeq"`
}

func (h *Hub) scheduleWhiteboardPersist(roomID uuid.UUID) {
	if h.whiteboardStore == nil {
		return
	}

	h.mu.Lock()
	if timer, ok := h.whiteboardPersistTimers[roomID]; ok {
		timer.Reset(whiteboardPersistDebounce)
		h.mu.Unlock()
		return
	}

	h.whiteboardPersistTimers[roomID] = time.AfterFunc(whiteboardPersistDebounce, func() {
		h.persistWhiteboardState(roomID)
	})
	h.mu.Unlock()
}

func (h *Hub) persistWhiteboardState(roomID uuid.UUID) {
	if h.whiteboardStore == nil {
		return
	}

	snapshot := h.GetWhiteboardSnapshot(roomID)

	h.mu.Lock()
	delete(h.whiteboardPersistTimers, roomID)
	h.mu.Unlock()

	var rawElements []json.RawMessage
	_ = json.Unmarshal(snapshot.Elements, &rawElements)

	state := persistedWhiteboardStateV2{
		SchemaVersion: whiteboardSchemaVersionV2,
		SceneID:       derefString(snapshot.SceneID),
		Elements:      rawElements,
		UpdatedAtMs:   derefInt64(snapshot.UpdatedAtMs),
		LastSeq:       snapshot.LastSeq,
	}

	data, err := json.Marshal(state)
	if err != nil {
		h.logger.Error("failed to marshal whiteboard state",
			"room_id", roomID,
			"error", err.Error(),
		)
		return
	}

	if err := h.whiteboardStore.Save(h.ctx, roomID, data); err != nil {
		h.logger.Error("failed to persist whiteboard state",
			"room_id", roomID,
			"error", err.Error(),
		)
	}
}

func (h *Hub) getOrRestoreWhiteboardState(roomID uuid.UUID) *WhiteboardState {
	h.mu.RLock()
	state := h.whiteboardState[roomID]
	h.mu.RUnlock()
	if state != nil {
		return state
	}

	if h.whiteboardStore == nil {
		return nil
	}

	loaded, err := h.whiteboardStore.Load(h.ctx, roomID)
	if err != nil || len(loaded) == 0 {
		return nil
	}

	return h.restoreWhiteboardState(roomID, loaded)
}

func (h *Hub) restoreWhiteboardState(roomID uuid.UUID, raw []byte) *WhiteboardState {
	// Try v2 first
	var persistedV2 persistedWhiteboardStateV2
	if err := json.Unmarshal(raw, &persistedV2); err == nil &&
		persistedV2.SchemaVersion == whiteboardSchemaVersionV2 &&
		persistedV2.SceneID != "" {
		state := newWhiteboardState(persistedV2.SceneID)
		state.UpdatedAtMs = persistedV2.UpdatedAtMs
		state.LastSeq = persistedV2.LastSeq

		for _, rawElement := range persistedV2.Elements {
			var meta elementMeta
			if err := json.Unmarshal(rawElement, &meta); err != nil {
				continue
			}
			if meta.ID == "" {
				continue
			}
			state.Elements[meta.ID] = storedElement{
				Raw:          rawElement,
				Version:      meta.Version,
				VersionNonce: meta.VersionNonce,
				Updated:      meta.Updated,
				IsDeleted:    meta.IsDeleted,
				Index:        meta.Index,
			}
		}

		h.mu.Lock()
		h.whiteboardState[roomID] = state
		h.mu.Unlock()
		return state
	}

	// Fallback v1 restore → v2 state
	var persistedV1 persistedWhiteboardStateV1
	if err := json.Unmarshal(raw, &persistedV1); err != nil {
		h.logger.Error("failed to parse persisted whiteboard state",
			"room_id", roomID,
			"error", err.Error(),
		)
		return nil
	}

	state := newWhiteboardState("")
	state.LastSeq = persistedV1.LastSeq

	if len(persistedV1.Elements) > 0 {
		var rawElements []json.RawMessage
		if err := json.Unmarshal(persistedV1.Elements, &rawElements); err == nil {
			for _, rawElement := range rawElements {
				var meta elementMeta
				if err := json.Unmarshal(rawElement, &meta); err != nil {
					continue
				}
				if meta.ID == "" {
					continue
				}
				state.Elements[meta.ID] = storedElement{
					Raw:          rawElement,
					Version:      meta.Version,
					VersionNonce: meta.VersionNonce,
					Updated:      meta.Updated,
					IsDeleted:    meta.IsDeleted,
					Index:        meta.Index,
				}
			}
		}
	}

	h.mu.Lock()
	h.whiteboardState[roomID] = state
	h.mu.Unlock()
	return state
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func derefInt64(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}
