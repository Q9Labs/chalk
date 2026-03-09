package websocket

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	"github.com/google/uuid"
)

const screenAnnotationPersistDebounce = 750 * time.Millisecond

type ScreenAnnotationStateStore interface {
	Save(ctx context.Context, roomID uuid.UUID, state []byte) error
	Load(ctx context.Context, roomID uuid.UUID) ([]byte, error)
}

type annotationItemMeta struct {
	ID          string `json:"id"`
	Version     int64  `json:"version"`
	UpdatedAtMs int64  `json:"updated_at_ms"`
	UpdatedAt   int64  `json:"updatedAtMs"`
	Deleted     bool   `json:"deleted"`
}

type storedAnnotationItem struct {
	Raw         json.RawMessage
	Version     int64
	UpdatedAtMs int64
	Deleted     bool
}

type ScreenAnnotationState struct {
	ShareSessionID      string
	SharerParticipantID uuid.UUID
	AccessMode          AnnotationAccessMode
	Items               map[string]storedAnnotationItem
	UpdatedAtMs         int64
	LastSeq             int64
}

func newScreenAnnotationState(shareSessionID string, sharerParticipantID uuid.UUID, accessMode AnnotationAccessMode) *ScreenAnnotationState {
	nowMs := time.Now().UnixMilli()
	return &ScreenAnnotationState{
		ShareSessionID:      shareSessionID,
		SharerParticipantID: sharerParticipantID,
		AccessMode:          normalizeAnnotationAccessMode(string(accessMode)),
		Items:               make(map[string]storedAnnotationItem),
		UpdatedAtMs:         nowMs,
		LastSeq:             0,
	}
}

func (h *Hub) StartScreenAnnotationSession(roomID uuid.UUID, payload AnnotationSessionStartPayload) AnnotationSessionStartedPayload {
	h.mu.Lock()
	h.screenAnnotationState[roomID] = newScreenAnnotationState(payload.ShareSessionID, payload.SharerParticipantID, payload.AccessMode)
	h.mu.Unlock()
	h.logger.Info("started screen annotation session",
		"event", "annotation.session.state.start",
		"room_id", roomID,
		"share_session_id", payload.ShareSessionID,
		"sharer_participant_id", payload.SharerParticipantID,
		"access_mode", payload.AccessMode,
	)

	go h.scheduleScreenAnnotationPersist(roomID)

	return AnnotationSessionStartedPayload{
		ShareSessionID:      payload.ShareSessionID,
		SharerParticipantID: payload.SharerParticipantID,
		AccessMode:          normalizeAnnotationAccessMode(string(payload.AccessMode)),
		Timestamp:           time.Now(),
	}
}

func (h *Hub) EndScreenAnnotationSession(roomID uuid.UUID, shareSessionID string) bool {
	h.mu.Lock()
	state := h.screenAnnotationState[roomID]
	if state == nil || state.ShareSessionID == "" || state.ShareSessionID != shareSessionID {
		h.mu.Unlock()
		return false
	}
	delete(h.screenAnnotationState, roomID)
	h.stopScreenAnnotationPersistTimerLocked(roomID)
	h.mu.Unlock()
	h.logger.Info("ended screen annotation session",
		"event", "annotation.session.state.end",
		"room_id", roomID,
		"share_session_id", shareSessionID,
		"sharer_participant_id", state.SharerParticipantID,
		"access_mode", state.AccessMode,
		"last_seq", state.LastSeq,
		"item_count", len(state.Items),
	)

	h.clearPersistedScreenAnnotationState(roomID)
	return true
}

func (h *Hub) SetScreenAnnotationAccessMode(roomID uuid.UUID, shareSessionID string, accessMode AnnotationAccessMode) (AnnotationAccessMode, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()

	state := h.screenAnnotationState[roomID]
	if state == nil || state.ShareSessionID == "" || state.ShareSessionID != shareSessionID {
		return "", false
	}

	state.AccessMode = normalizeAnnotationAccessMode(string(accessMode))
	state.UpdatedAtMs = time.Now().UnixMilli()
	go h.scheduleScreenAnnotationPersist(roomID)
	return state.AccessMode, true
}

func (h *Hub) UpdateScreenAnnotationState(roomID uuid.UUID, payload AnnotationUpdatePayload) bool {
	h.mu.Lock()
	defer h.mu.Unlock()

	state := h.screenAnnotationState[roomID]
	if state == nil || state.ShareSessionID == "" {
		return false
	}
	if payload.ShareSessionID != state.ShareSessionID || payload.SharerParticipantID != state.SharerParticipantID {
		return false
	}

	state.UpdatedAtMs = time.Now().UnixMilli()
	if payload.Seq > state.LastSeq {
		state.LastSeq = payload.Seq
	}

	var rawItems []json.RawMessage
	if len(payload.Items) > 0 {
		if err := json.Unmarshal(payload.Items, &rawItems); err != nil {
			return true
		}
	}

	for _, raw := range rawItems {
		var meta annotationItemMeta
		if err := json.Unmarshal(raw, &meta); err != nil {
			continue
		}
		if meta.ID == "" {
			continue
		}
		updatedAtMs := meta.UpdatedAtMs
		if updatedAtMs == 0 {
			updatedAtMs = meta.UpdatedAt
		}

		existing, exists := state.Items[meta.ID]
		accept := !exists || meta.Version > existing.Version || (meta.Version == existing.Version && updatedAtMs >= existing.UpdatedAtMs)
		if !accept {
			continue
		}

		state.Items[meta.ID] = storedAnnotationItem{
			Raw:         raw,
			Version:     meta.Version,
			UpdatedAtMs: updatedAtMs,
			Deleted:     meta.Deleted,
		}
	}

	go h.scheduleScreenAnnotationPersist(roomID)
	return true
}

func (h *Hub) ClearScreenAnnotationState(roomID uuid.UUID, shareSessionID string, seq int64) bool {
	h.mu.Lock()
	defer h.mu.Unlock()

	state := h.screenAnnotationState[roomID]
	if state == nil || state.ShareSessionID == "" || state.ShareSessionID != shareSessionID {
		return false
	}

	state.Items = make(map[string]storedAnnotationItem)
	state.UpdatedAtMs = time.Now().UnixMilli()
	if seq > state.LastSeq {
		state.LastSeq = seq
	}

	go h.scheduleScreenAnnotationPersist(roomID)
	return true
}

func (h *Hub) GetScreenAnnotationSnapshot(roomID uuid.UUID) (AnnotationSnapshotPayload, bool) {
	state := h.getOrRestoreScreenAnnotationState(roomID)
	if state == nil || state.ShareSessionID == "" {
		return AnnotationSnapshotPayload{}, false
	}

	h.mu.RLock()
	items := make([]struct {
		id  string
		raw json.RawMessage
	}, 0, len(state.Items))
	for id, item := range state.Items {
		items = append(items, struct {
			id  string
			raw json.RawMessage
		}{id: id, raw: item.Raw})
	}
	snapshot := AnnotationSnapshotPayload{
		RoomID:              roomID,
		ShareSessionID:      state.ShareSessionID,
		SharerParticipantID: state.SharerParticipantID,
		AccessMode:          state.AccessMode,
		UpdatedAtMs:         state.UpdatedAtMs,
		LastSeq:             state.LastSeq,
	}
	h.mu.RUnlock()

	sort.Slice(items, func(i, j int) bool {
		return items[i].id < items[j].id
	})

	rawItems := make([]json.RawMessage, 0, len(items))
	for _, item := range items {
		rawItems = append(rawItems, item.raw)
	}
	snapshot.Items = json.RawMessage("[]")
	if len(rawItems) > 0 {
		snapshot.Items, _ = json.Marshal(rawItems)
	}

	return snapshot, true
}
