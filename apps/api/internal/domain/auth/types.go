package auth

import (
	"time"

	"github.com/google/uuid"
)

// Claims represents the JWT claims for Chalk tokens
type Claims struct {
	// Standard claims
	Subject   string    `json:"sub"` // participant_id
	IssuedAt  time.Time `json:"iat"`
	ExpiresAt time.Time `json:"exp"`

	// Chalk-specific claims
	TenantID    uuid.UUID   `json:"tenant_id"`
	RoomID      uuid.UUID   `json:"room_id,omitempty"`
	DisplayName string      `json:"display_name,omitempty"`
	Role        string      `json:"role,omitempty"` // host, participant
	Permissions Permissions `json:"permissions,omitempty"`

	// Cloudflare auth token (for WebRTC connection)
	CFAuthToken string `json:"cf_auth_token,omitempty"`
}

// Permissions defines what actions a participant can perform
type Permissions struct {
	CanRecord      bool `json:"can_record"`
	CanScreenShare bool `json:"can_screen_share"`
	CanKick        bool `json:"can_kick"`
	CanMute        bool `json:"can_mute"`
}

// DefaultHostPermissions returns permissions for a host
func DefaultHostPermissions() Permissions {
	return Permissions{
		CanRecord:      true,
		CanScreenShare: true,
		CanKick:        true,
		CanMute:        true,
	}
}

// DefaultParticipantPermissions returns permissions for a regular participant
func DefaultParticipantPermissions() Permissions {
	return Permissions{
		CanRecord:      false,
		CanScreenShare: true,
		CanKick:        false,
		CanMute:        false,
	}
}

// APIKeyInfo contains information about an API key
type APIKeyInfo struct {
	TenantID uuid.UUID
	KeyHash  string
}

// TokenPair contains access and refresh tokens
type TokenPair struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	TokenType    string    `json:"token_type"`
	ExpiresIn    int       `json:"expires_in"` // seconds
	ExpiresAt    time.Time `json:"expires_at"`
}
