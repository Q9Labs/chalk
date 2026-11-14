package recorderprotocol

import (
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
)

type CaptureAuthority struct {
	SignalingHandle   string `json:"signaling_handle"`
	TenantID          string `json:"tenant_id"`
	SpaceID           string `json:"space_id"`
	EpisodeID         string `json:"episode_id"`
	RecordingID       string `json:"recording_id"`
	JobID             string `json:"job_id"`
	AttemptCount      int    `json:"attempt_count"`
	FencingGeneration int64  `json:"fencing_generation"`
	CaptureEpoch      int64  `json:"capture_epoch"`
	EnvelopeDigest    string `json:"envelope_digest"`
	LeaseToken        string `json:"lease_token"`
	LeaseExpiresAt    string `json:"lease_expires_at"`
	PlanRevision      int64  `json:"plan_revision"`
	IdempotencyKey    string `json:"idempotency_key"`
}

type CaptureCreateRequest struct {
	CaptureAuthority
}

type CapturePullRequest struct {
	CaptureAuthority
	Connection       string                    `json:"connection"`
	Tracks           []CaptureTrack            `json:"tracks"`
	LocalDescription *captureplane.Description `json:"local_description,omitempty"`
}

type CaptureRenegotiateRequest struct {
	CaptureAuthority
	Connection    string                   `json:"connection"`
	NegotiationID string                   `json:"negotiation_id"`
	Description   captureplane.Description `json:"description"`
}

type CaptureInspectRequest struct {
	CaptureAuthority
	Connection string               `json:"connection"`
	Tracks     []CapturePulledTrack `json:"tracks,omitempty"`
}

type CaptureCloseTracksRequest struct {
	CaptureAuthority
	Connection string               `json:"connection"`
	Tracks     []CapturePulledTrack `json:"tracks"`
}

type CaptureCloseConnectionRequest struct {
	CaptureAuthority
	Connection string               `json:"connection"`
	Tracks     []CapturePulledTrack `json:"tracks,omitempty"`
	Force      bool                 `json:"force"`
}

type CaptureTrack struct {
	OwnerReference        string `json:"owner_reference"`
	TrackReference        string `json:"track_reference"`
	ParticipantID         string `json:"participant_id"`
	ParticipantGeneration int64  `json:"participant_generation"`
	Source                string `json:"source"`
	Kind                  string `json:"kind"`
	RequestedLayer        string `json:"requested_layer"`
}

type CapturePulledTrack struct {
	OwnerReference        string `json:"owner_reference"`
	TrackReference        string `json:"track_reference"`
	ParticipantID         string `json:"participant_id"`
	ParticipantGeneration int64  `json:"participant_generation"`
	Source                string `json:"source"`
	Kind                  string `json:"kind"`
	RequestedLayer        string `json:"requested_layer"`
	MID                   string `json:"mid"`
}

type CaptureSignalingResponse struct {
	Replayed bool                           `json:"replayed"`
	Result   capturesignaling.CommandResult `json:"result"`
}
