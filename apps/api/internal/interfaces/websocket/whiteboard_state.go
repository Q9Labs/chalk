package websocket

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	"github.com/google/uuid"
)

const (
	whiteboardPersistDebounce        = 750 * time.Millisecond
	whiteboardTombstoneRetention     = 24 * time.Hour
	whiteboardSchemaVersionV2    int = 2
)

type WhiteboardStateStore interface {
	Save(ctx context.Context, roomID uuid.UUID, state []byte) error
	Load(ctx context.Context, roomID uuid.UUID) ([]byte, error)
}

type elementMeta struct {
	ID           string `json:"id"`
	Version      int64  `json:"version"`
	VersionNonce int64  `json:"versionNonce"`
	Updated      int64  `json:"updated"`
	IsDeleted    bool   `json:"isDeleted"`
	Index        string `json:"index"`
}

type storedElement struct {
	Raw          json.RawMessage
	Version      int64
	VersionNonce int64
	Updated      int64
	IsDeleted    bool
	Index        string
}

type WhiteboardState struct {
	SceneID     string
	Elements    map[string]storedElement
	UpdatedAtMs int64
	LastSeq     int64
}

func newWhiteboardState(sceneID string) *WhiteboardState {
	if sceneID == "" {
		sceneID = uuid.NewString()
	}
	now := time.Now().UnixMilli()
	return &WhiteboardState{
		SceneID:     sceneID,
		Elements:    make(map[string]storedElement),
		UpdatedAtMs: now,
		LastSeq:     0,
	}
}

// UpdateWhiteboardState merges an update into the in-memory room state.
//
// Returns (sceneID, applied). `applied=false` when the update is for a stale epoch.
func (h *Hub) UpdateWhiteboardState(roomID uuid.UUID, payload WhiteboardUpdateV2Payload) (string, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()

	state, ok := h.whiteboardState[roomID]
	if !ok {
		// Bootstrap epoch from client if provided; otherwise generate.
		state = newWhiteboardState(payload.SceneID)
		h.whiteboardState[roomID] = state
	}

	// Reject stale epoch updates (prevents resurrection after clear).
	if payload.SceneID != "" && payload.SceneID != state.SceneID {
		return state.SceneID, false
	}

	nowMs := time.Now().UnixMilli()
	state.UpdatedAtMs = nowMs

	if payload.Seq > state.LastSeq {
		state.LastSeq = payload.Seq
	}

	var rawElements []json.RawMessage
	if len(payload.Elements) > 0 {
		if err := json.Unmarshal(payload.Elements, &rawElements); err != nil {
			return state.SceneID, true
		}
	}

	for _, raw := range rawElements {
		var meta elementMeta
		if err := json.Unmarshal(raw, &meta); err != nil {
			continue
		}
		if meta.ID == "" {
			continue
		}

		existing, exists := state.Elements[meta.ID]
		accept := !exists ||
			meta.Version > existing.Version ||
			(meta.Version == existing.Version && meta.VersionNonce != 0 && (existing.VersionNonce == 0 || meta.VersionNonce < existing.VersionNonce))

		if !accept {
			continue
		}

		state.Elements[meta.ID] = storedElement{
			Raw:          raw,
			Version:      meta.Version,
			VersionNonce: meta.VersionNonce,
			Updated:      meta.Updated,
			IsDeleted:    meta.IsDeleted,
			Index:        meta.Index,
		}
	}

	go h.scheduleWhiteboardPersist(roomID)
	return state.SceneID, true
}

// ClearWhiteboardState resets the in-memory whiteboard state for a room and advances the epoch.
func (h *Hub) ClearWhiteboardState(roomID uuid.UUID) string {
	h.mu.Lock()

	state, ok := h.whiteboardState[roomID]
	if !ok {
		state = newWhiteboardState("")
		h.whiteboardState[roomID] = state
	}

	state.SceneID = uuid.NewString()
	state.Elements = make(map[string]storedElement)
	state.UpdatedAtMs = time.Now().UnixMilli()
	state.LastSeq = state.UpdatedAtMs

	h.mu.Unlock()

	go h.scheduleWhiteboardPersist(roomID)
	return state.SceneID
}

// GetWhiteboardSnapshot returns a full snapshot of the in-memory whiteboard state.
// If no in-memory state exists, it attempts to restore from persistence; otherwise it returns an empty snapshot.
func (h *Hub) GetWhiteboardSnapshot(roomID uuid.UUID) WhiteboardSnapshotPayload {
	state := h.getOrRestoreWhiteboardState(roomID)
	if state == nil {
		state = newWhiteboardState("")
		h.mu.Lock()
		h.whiteboardState[roomID] = state
		h.mu.Unlock()
	}

	nowMs := time.Now().UnixMilli()
	h.pruneTombstones(roomID, nowMs)

	// Build a stable, deterministic ordering (by index then id) to reduce churn.
	type item struct {
		id    string
		index string
		raw   json.RawMessage
	}
	list := make([]item, 0, len(state.Elements))
	h.mu.RLock()
	for id, el := range state.Elements {
		list = append(list, item{id: id, index: el.Index, raw: el.Raw})
	}
	sceneID := state.SceneID
	updatedAt := state.UpdatedAtMs
	lastSeq := state.LastSeq
	h.mu.RUnlock()

	sort.Slice(list, func(i, j int) bool {
		if list[i].index == list[j].index {
			return list[i].id < list[j].id
		}
		// Empty index sorts last.
		if list[i].index == "" {
			return false
		}
		if list[j].index == "" {
			return true
		}
		return list[i].index < list[j].index
	})

	rawList := make([]json.RawMessage, 0, len(list))
	for _, it := range list {
		rawList = append(rawList, it.raw)
	}
	elementsData, _ := json.Marshal(rawList)
	if len(elementsData) == 0 {
		elementsData = json.RawMessage("[]")
	}

	filesData := json.RawMessage("{}")
	appState := json.RawMessage("{}")

	return WhiteboardSnapshotPayload{
		SchemaVersion: int64(whiteboardSchemaVersionV2),
		RoomID:        roomID,
		SceneID:       sceneID,
		Elements:      elementsData,
		Files:         filesData,
		AppState:      appState,
		UpdatedAtMs:   updatedAt,
		LastSeq:       lastSeq,
	}
}

func (h *Hub) pruneTombstones(roomID uuid.UUID, nowMs int64) {
	cutoff := nowMs - whiteboardTombstoneRetention.Milliseconds()
	h.mu.Lock()
	state := h.whiteboardState[roomID]
	if state == nil {
		h.mu.Unlock()
		return
	}

	for id, el := range state.Elements {
		if el.IsDeleted && el.Updated > 0 && el.Updated < cutoff {
			delete(state.Elements, id)
		}
	}
	h.mu.Unlock()
}
