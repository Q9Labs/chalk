package websocket

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

type persistedScreenAnnotationState struct {
	ShareSessionID      string               `json:"shareSessionId"`
	SharerParticipantID uuid.UUID            `json:"sharerParticipantId"`
	AccessMode          AnnotationAccessMode `json:"accessMode"`
	Items               []json.RawMessage    `json:"items"`
	UpdatedAtMs         int64                `json:"updatedAtMs"`
	LastSeq             int64                `json:"lastSeq"`
}

func (h *Hub) scheduleScreenAnnotationPersist(roomID uuid.UUID) {
	if h.screenAnnotationStore == nil {
		return
	}

	h.mu.Lock()
	if timer, ok := h.screenAnnotationPersistTimers[roomID]; ok {
		timer.Reset(screenAnnotationPersistDebounce)
		h.mu.Unlock()
		return
	}

	h.screenAnnotationPersistTimers[roomID] = time.AfterFunc(screenAnnotationPersistDebounce, func() {
		h.persistScreenAnnotationState(roomID)
	})
	h.mu.Unlock()
}

func (h *Hub) persistScreenAnnotationState(roomID uuid.UUID) {
	if h.screenAnnotationStore == nil {
		return
	}

	snapshot, ok := h.GetScreenAnnotationSnapshot(roomID)

	h.mu.Lock()
	delete(h.screenAnnotationPersistTimers, roomID)
	h.mu.Unlock()

	if !ok {
		h.clearPersistedScreenAnnotationState(roomID)
		return
	}

	var rawItems []json.RawMessage
	_ = json.Unmarshal(snapshot.Items, &rawItems)

	data, err := json.Marshal(persistedScreenAnnotationState{
		ShareSessionID:      snapshot.ShareSessionID,
		SharerParticipantID: snapshot.SharerParticipantID,
		AccessMode:          snapshot.AccessMode,
		Items:               rawItems,
		UpdatedAtMs:         snapshot.UpdatedAtMs,
		LastSeq:             snapshot.LastSeq,
	})
	if err != nil {
		h.logger.Error("failed to marshal screen annotation state", "room_id", roomID, "error", err.Error())
		return
	}

	if err := h.screenAnnotationStore.Save(h.ctxOrBackground(), roomID, data); err != nil {
		h.logger.Error("failed to persist screen annotation state", "room_id", roomID, "error", err.Error())
	}
}

func (h *Hub) clearPersistedScreenAnnotationState(roomID uuid.UUID) {
	if h.screenAnnotationStore == nil {
		return
	}
	if err := h.screenAnnotationStore.Save(h.ctxOrBackground(), roomID, nil); err != nil {
		h.logger.Error("failed to clear persisted screen annotation state", "room_id", roomID, "error", err.Error())
	}
}

func (h *Hub) getOrRestoreScreenAnnotationState(roomID uuid.UUID) *ScreenAnnotationState {
	h.mu.RLock()
	state := h.screenAnnotationState[roomID]
	h.mu.RUnlock()
	if state != nil {
		return state
	}
	if h.screenAnnotationStore == nil {
		return nil
	}

	loaded, err := h.screenAnnotationStore.Load(h.ctxOrBackground(), roomID)
	if err != nil || len(loaded) == 0 {
		return nil
	}

	var persisted persistedScreenAnnotationState
	if err := json.Unmarshal(loaded, &persisted); err != nil || persisted.ShareSessionID == "" {
		return nil
	}

	state = newScreenAnnotationState(persisted.ShareSessionID, persisted.SharerParticipantID, persisted.AccessMode)
	state.UpdatedAtMs = persisted.UpdatedAtMs
	state.LastSeq = persisted.LastSeq
	for _, rawItem := range persisted.Items {
		var meta annotationItemMeta
		if err := json.Unmarshal(rawItem, &meta); err != nil || meta.ID == "" {
			continue
		}
		updatedAtMs := meta.UpdatedAtMs
		if updatedAtMs == 0 {
			updatedAtMs = meta.UpdatedAt
		}
		state.Items[meta.ID] = storedAnnotationItem{
			Raw:         rawItem,
			Version:     meta.Version,
			UpdatedAtMs: updatedAtMs,
			Deleted:     meta.Deleted,
		}
	}

	h.mu.Lock()
	h.screenAnnotationState[roomID] = state
	h.mu.Unlock()
	return state
}

func (h *Hub) stopScreenAnnotationPersistTimerLocked(roomID uuid.UUID) {
	if timer, ok := h.screenAnnotationPersistTimers[roomID]; ok {
		timer.Stop()
		delete(h.screenAnnotationPersistTimers, roomID)
	}
}

func (h *Hub) ctxOrBackground() context.Context {
	if h.ctx != nil {
		return h.ctx
	}
	return context.Background()
}
