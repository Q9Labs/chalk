package websocket

import (
	"strings"

	"github.com/google/uuid"
)

func normalizeAnnotationAccessMode(raw string) AnnotationAccessMode {
	switch strings.TrimSpace(strings.ToLower(raw)) {
	case string(AnnotationAccessModeSharerOnly):
		return AnnotationAccessModeSharerOnly
	case string(AnnotationAccessModeOff):
		return AnnotationAccessModeOff
	default:
		return AnnotationAccessModeAll
	}
}

func (h *Hub) CanParticipantAnnotate(roomID, participantID uuid.UUID) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()

	state := h.screenAnnotationState[roomID]
	if state == nil || state.ShareSessionID == "" {
		return false
	}

	switch state.AccessMode {
	case AnnotationAccessModeSharerOnly:
		return state.SharerParticipantID == participantID
	case AnnotationAccessModeOff:
		return false
	default:
		return true
	}
}

func (h *Hub) isHostParticipant(participantID uuid.UUID) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()

	meta := h.participantMeta[participantID]
	return strings.EqualFold(meta.Role, "host")
}
