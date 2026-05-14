package websocket

import (
	"encoding/json"
	"strings"

	"github.com/google/uuid"
)

type WhiteboardDefaultAccess string

const (
	WhiteboardDefaultAccessAll      WhiteboardDefaultAccess = "all"
	WhiteboardDefaultAccessHostOnly WhiteboardDefaultAccess = "host_only"
	WhiteboardDefaultAccessNone     WhiteboardDefaultAccess = "none"
)

type WhiteboardRoomPolicy struct {
	DefaultAccess   WhiteboardDefaultAccess `json:"default_access"`
	HostCanOverride bool                    `json:"host_can_override"`
}

func defaultWhiteboardRoomPolicy() WhiteboardRoomPolicy {
	return WhiteboardRoomPolicy{
		DefaultAccess:   WhiteboardDefaultAccessAll,
		HostCanOverride: true,
	}
}

func normalizeWhiteboardDefaultAccess(raw string) WhiteboardDefaultAccess {
	switch strings.TrimSpace(strings.ToLower(raw)) {
	case string(WhiteboardDefaultAccessHostOnly):
		return WhiteboardDefaultAccessHostOnly
	case string(WhiteboardDefaultAccessNone):
		return WhiteboardDefaultAccessNone
	default:
		return WhiteboardDefaultAccessAll
	}
}

func ParseWhiteboardRoomPolicy(raw []byte) WhiteboardRoomPolicy {
	policy := defaultWhiteboardRoomPolicy()
	if len(raw) == 0 {
		return policy
	}

	var input struct {
		DefaultAccess   string `json:"default_access"`
		HostCanOverride *bool  `json:"host_can_override"`
	}

	if err := json.Unmarshal(raw, &input); err != nil {
		return policy
	}

	policy.DefaultAccess = normalizeWhiteboardDefaultAccess(input.DefaultAccess)
	if input.HostCanOverride != nil {
		policy.HostCanOverride = *input.HostCanOverride
	}

	return policy
}

func (h *Hub) SetRoomWhiteboardPolicy(roomID uuid.UUID, policy WhiteboardRoomPolicy) {
	h.mu.Lock()
	defer h.mu.Unlock()

	policy.DefaultAccess = normalizeWhiteboardDefaultAccess(string(policy.DefaultAccess))
	h.whiteboardPolicy[roomID] = policy
}

func (h *Hub) CanHostOverrideWhiteboard(roomID uuid.UUID) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()

	policy, ok := h.whiteboardPolicy[roomID]
	if !ok {
		policy = defaultWhiteboardRoomPolicy()
	}
	return policy.HostCanOverride
}

func (h *Hub) SetParticipantWhiteboardPermission(roomID, participantID uuid.UUID, canDraw bool) {
	h.mu.Lock()
	defer h.mu.Unlock()

	permissions, ok := h.whiteboardPermissions[roomID]
	if !ok {
		permissions = make(map[uuid.UUID]bool)
		h.whiteboardPermissions[roomID] = permissions
	}
	permissions[participantID] = canDraw
}

func (h *Hub) CanParticipantDraw(roomID, participantID uuid.UUID) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()

	policy, ok := h.whiteboardPolicy[roomID]
	if !ok {
		policy = defaultWhiteboardRoomPolicy()
	}

	if permissions, ok := h.whiteboardPermissions[roomID]; ok {
		if allowed, exists := permissions[participantID]; exists {
			return allowed
		}
	}

	meta := h.participantMeta[participantID]
	isHost := strings.EqualFold(meta.Role, "host")

	switch policy.DefaultAccess {
	case WhiteboardDefaultAccessHostOnly:
		return isHost
	case WhiteboardDefaultAccessNone:
		return false
	default:
		return true
	}
}
