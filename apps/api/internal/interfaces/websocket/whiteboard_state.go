package websocket

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/google/uuid"
)

const whiteboardPersistDebounce = 750 * time.Millisecond

type WhiteboardStateStore interface {
	Save(ctx context.Context, roomID uuid.UUID, state []byte) error
	Load(ctx context.Context, roomID uuid.UUID) ([]byte, error)
}

type storedElement struct {
	Raw     json.RawMessage
	Version int64
}

type WhiteboardState struct {
	Elements map[string]storedElement
	Files    map[string]json.RawMessage
	AppState json.RawMessage
	LastSeq  int64
}

func newWhiteboardState() *WhiteboardState {
	return &WhiteboardState{
		Elements: make(map[string]storedElement),
		Files:    make(map[string]json.RawMessage),
		AppState: json.RawMessage("{}"),
		LastSeq:  0,
	}
}

type elementMeta struct {
	ID        string `json:"id"`
	Version   int64  `json:"version"`
	IsDeleted bool   `json:"isDeleted"`
}

type persistedWhiteboardState struct {
	Elements json.RawMessage `json:"elements"`
	Files    json.RawMessage `json:"files"`
	AppState json.RawMessage `json:"appState"`
	LastSeq  int64           `json:"lastSeq"`
}

// UpdateWhiteboardState merges a delta update into the in-memory room state.
func (h *Hub) UpdateWhiteboardState(roomID uuid.UUID, payload WhiteboardUpdatePayload) {
	h.mu.Lock()
	defer h.mu.Unlock()

	state, ok := h.whiteboardState[roomID]
	if !ok {
		state = newWhiteboardState()
		h.whiteboardState[roomID] = state
	}

	if len(payload.Elements) > 0 {
		var rawElements []json.RawMessage
		if err := json.Unmarshal(payload.Elements, &rawElements); err != nil {
			log.Printf("[WB-STATE] Failed to parse elements for room %s: %v", roomID, err)
		} else {
			for _, raw := range rawElements {
				var meta elementMeta
				if err := json.Unmarshal(raw, &meta); err != nil {
					continue
				}
				if meta.ID == "" {
					continue
				}
				if meta.IsDeleted {
					delete(state.Elements, meta.ID)
					continue
				}

				existing, exists := state.Elements[meta.ID]
				if !exists || meta.Version >= existing.Version {
					state.Elements[meta.ID] = storedElement{Raw: raw, Version: meta.Version}
				}
			}
		}
	}

	if len(payload.Files) > 0 {
		var files map[string]json.RawMessage
		if err := json.Unmarshal(payload.Files, &files); err != nil {
			log.Printf("[WB-STATE] Failed to parse files for room %s: %v", roomID, err)
		} else {
			for id, raw := range files {
				state.Files[id] = raw
			}
		}
	}

	if len(payload.AppState) > 0 {
		state.AppState = payload.AppState
	}

	if payload.Seq > state.LastSeq {
		state.LastSeq = payload.Seq
	}

	go h.scheduleWhiteboardPersist(roomID)
}

// ClearWhiteboardState resets the in-memory whiteboard state for a room.
func (h *Hub) ClearWhiteboardState(roomID uuid.UUID) {
	h.mu.Lock()

	state, ok := h.whiteboardState[roomID]
	if !ok {
		state = newWhiteboardState()
		h.whiteboardState[roomID] = state
	}

	state.Elements = make(map[string]storedElement)
	state.Files = make(map[string]json.RawMessage)
	state.AppState = json.RawMessage("{}")
	state.LastSeq = time.Now().UnixMilli()
	h.mu.Unlock()

	go h.scheduleWhiteboardPersist(roomID)
}

// GetWhiteboardSnapshot returns a full snapshot of the in-memory whiteboard state.
func (h *Hub) GetWhiteboardSnapshot(roomID uuid.UUID) (WhiteboardSnapshotPayload, bool) {
	h.mu.RLock()
	state, ok := h.whiteboardState[roomID]
	h.mu.RUnlock()

	if !ok && h.whiteboardStore != nil {
		if loaded, err := h.whiteboardStore.Load(h.ctx, roomID); err == nil && len(loaded) > 0 {
			if restored := h.restoreWhiteboardState(roomID, loaded); restored != nil {
				state = restored
				ok = true
			}
		}
	}

	if !ok {
		return WhiteboardSnapshotPayload{}, false
	}

	elementsData := json.RawMessage("[]")
	if len(state.Elements) > 0 {
		list := make([]json.RawMessage, 0, len(state.Elements))
		for _, element := range state.Elements {
			list = append(list, element.Raw)
		}
		if data, err := json.Marshal(list); err == nil {
			elementsData = data
		}
	}

	filesData := json.RawMessage("{}")
	if len(state.Files) > 0 {
		if data, err := json.Marshal(state.Files); err == nil {
			filesData = data
		}
	}

	appState := state.AppState
	if len(appState) == 0 {
		appState = json.RawMessage("{}")
	}

	if state.LastSeq == 0 && len(state.Elements) == 0 && len(state.Files) == 0 {
		return WhiteboardSnapshotPayload{}, false
	}

	return WhiteboardSnapshotPayload{
		RoomID:   roomID,
		Elements: elementsData,
		Files:    filesData,
		AppState: appState,
		LastSeq:  state.LastSeq,
	}, true
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
	snapshot, ok := h.GetWhiteboardSnapshot(roomID)

	h.mu.Lock()
	delete(h.whiteboardPersistTimers, roomID)
	h.mu.Unlock()

	if !ok {
		return
	}

	state := persistedWhiteboardState{
		Elements: snapshot.Elements,
		Files:    snapshot.Files,
		AppState: snapshot.AppState,
		LastSeq:  snapshot.LastSeq,
	}
	data, err := json.Marshal(state)
	if err != nil {
		log.Printf("[WB-STATE] Failed to marshal state for room %s: %v", roomID, err)
		return
	}

	if err := h.whiteboardStore.Save(h.ctx, roomID, data); err != nil {
		log.Printf("[WB-STATE] Failed to persist state for room %s: %v", roomID, err)
	}
}

func (h *Hub) restoreWhiteboardState(roomID uuid.UUID, raw []byte) *WhiteboardState {
	var persisted persistedWhiteboardState
	if err := json.Unmarshal(raw, &persisted); err != nil {
		log.Printf("[WB-STATE] Failed to parse persisted state for room %s: %v", roomID, err)
		return nil
	}

	state := newWhiteboardState()
	state.LastSeq = persisted.LastSeq

	if len(persisted.Elements) > 0 {
		var rawElements []json.RawMessage
		if err := json.Unmarshal(persisted.Elements, &rawElements); err == nil {
			for _, rawElement := range rawElements {
				var meta elementMeta
				if err := json.Unmarshal(rawElement, &meta); err != nil {
					continue
				}
				if meta.ID == "" || meta.IsDeleted {
					continue
				}
				state.Elements[meta.ID] = storedElement{Raw: rawElement, Version: meta.Version}
			}
		}
	}

	if len(persisted.Files) > 0 {
		var files map[string]json.RawMessage
		if err := json.Unmarshal(persisted.Files, &files); err == nil {
			state.Files = files
		}
	}

	if len(persisted.AppState) > 0 {
		state.AppState = persisted.AppState
	}

	h.mu.Lock()
	h.whiteboardState[roomID] = state
	h.mu.Unlock()

	return state
}
