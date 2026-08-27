package captureplane

import (
	"context"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	MaxCaptureTracks       = 64
	MaxProviderReference   = 512
	MaxIdempotencyKeyBytes = 128
	MaxSDPBytes            = 1 << 20
)

// CaptureEpoch fences all provider signaling after a recorder reconnect.
type CaptureEpoch uint64

// PlanRevision identifies the immutable CapturePlan observed by an operation.
type PlanRevision uint64

// ProviderReference is an opaque provider-owned identifier. CapturePlane
// adapters may construct it, but the control plane never parses its contents.
type ProviderReference string

func (r ProviderReference) String() string { return string(r) }

func (r ProviderReference) IsZero() bool { return r == "" }

// NewProviderReference validates and preserves an opaque provider identifier.
func NewProviderReference(value string) (ProviderReference, error) {
	if err := validateProviderReference(ProviderReference(value)); err != nil {
		return "", err
	}
	return ProviderReference(value), nil
}

// CaptureIdentity is the Chalk identity carried through every provider call.
// Provider references must never be used as replacements for these IDs.
type CaptureIdentity struct {
	TenantID    utilities.ID `json:"tenant_id"`
	SpaceID     utilities.ID `json:"space_id"`
	EpisodeID   utilities.ID `json:"episode_id"`
	RecordingID utilities.ID `json:"recording_id"`
}

// OperationMetadata is the common fence and retry identity for every
// CapturePlane operation.
type OperationMetadata struct {
	Identity       CaptureIdentity `json:"identity"`
	CaptureEpoch   CaptureEpoch    `json:"capture_epoch"`
	PlanRevision   PlanRevision    `json:"plan_revision"`
	IdempotencyKey string          `json:"idempotency_key"`
}

// OperationKind is part of an adapter's idempotency key namespace.
type OperationKind string

const (
	OperationCreateCaptureConnection      OperationKind = "create_capture_connection"
	OperationPullCaptureTracks            OperationKind = "pull_capture_tracks"
	OperationRenegotiateCaptureConnection OperationKind = "renegotiate_capture_connection"
	OperationInspectCaptureConnection     OperationKind = "inspect_capture_connection"
	OperationCloseCaptureTracks           OperationKind = "close_capture_tracks"
	OperationCloseCaptureConnection       OperationKind = "close_capture_connection"
)

// TrackSource identifies the publication source in Chalk vocabulary.
type TrackSource string

const (
	TrackSourceMicrophone TrackSource = "microphone"
	TrackSourceCamera     TrackSource = "camera"
	TrackSourceScreen     TrackSource = "screen"
)

// TrackKind identifies the media kind carried by a publication.
type TrackKind string

const (
	TrackKindAudio TrackKind = "audio"
	TrackKindVideo TrackKind = "video"
)

// TrackLayer is the provider-neutral simulcast selection. Auto lets an adapter
// choose the highest layer within the CapturePlan bitrate budget.
type TrackLayer string

const (
	TrackLayerAuto   TrackLayer = "auto"
	TrackLayerHigh   TrackLayer = "high"
	TrackLayerMedium TrackLayer = "medium"
	TrackLayerLow    TrackLayer = "low"
)

// CaptureTrack binds an opaque provider publication to a Chalk Participant
// generation. The owner and track references have meaning only to an adapter.
type CaptureTrack struct {
	OwnerReference        ProviderReference `json:"owner_reference"`
	TrackReference        ProviderReference `json:"track_reference"`
	ParticipantID         utilities.ID      `json:"participant_id"`
	ParticipantGeneration int64             `json:"participant_generation"`
	Source                TrackSource       `json:"source"`
	Kind                  TrackKind         `json:"kind"`
	RequestedLayer        TrackLayer        `json:"requested_layer"`
}

// CaptureConnection is the provider connection handle returned by a successful
// create operation.
type CaptureConnection struct {
	ConnectionReference ProviderReference `json:"connection_reference"`
	CaptureEpoch        CaptureEpoch      `json:"capture_epoch"`
	PlanRevision        PlanRevision      `json:"plan_revision"`
}

// Description is the provider-neutral SDP envelope. Its body remains
// opaque to the control plane and is exchanged only through worker scope.
type Description struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

// NegotiationRequirement tells the worker whether another SDP exchange is
// required before it can consume RTP.
type NegotiationRequirement string

const (
	NegotiationNotRequired  NegotiationRequirement = "not_required"
	NegotiationAnswerNeeded NegotiationRequirement = "answer_needed"
	NegotiationOfferNeeded  NegotiationRequirement = "offer_needed"
	// NegotiationRemoteAnswer tells the worker to apply the provider answer to
	// its local peer connection. It is terminal for this command and must not
	// be sent back through RenegotiateCaptureConnection.
	NegotiationRemoteAnswer NegotiationRequirement = "remote_answer"
)

// Negotiation is a bounded SDP handoff. ID fences an answer to the offer that
// created it and must be treated as opaque by the control plane.
type Negotiation struct {
	ID          ProviderReference      `json:"id,omitempty"`
	Requirement NegotiationRequirement `json:"requirement"`
	Description *Description           `json:"description,omitempty"`
}

// PulledCaptureTrack is a provider track that the adapter attached to the
// recorder connection.
type PulledCaptureTrack struct {
	CaptureTrack
	MID ProviderReference `json:"mid"`
}

// ObservedCaptureTrack is a provider track reported by inspection.
type ObservedCaptureTrack struct {
	PulledCaptureTrack
	Active bool `json:"active"`
}

// CaptureConnectionState is intentionally smaller than any provider state
// machine. Adapters map provider states into this bounded vocabulary.
type CaptureConnectionState string

const (
	CaptureConnectionConnecting   CaptureConnectionState = "connecting"
	CaptureConnectionConnected    CaptureConnectionState = "connected"
	CaptureConnectionDisconnected CaptureConnectionState = "disconnected"
	CaptureConnectionClosed       CaptureConnectionState = "closed"
)

type CreateCaptureConnectionInput struct {
	Metadata OperationMetadata `json:"metadata"`
}

type CreateCaptureConnectionResult struct {
	Connection  CaptureConnection `json:"connection"`
	Negotiation Negotiation       `json:"negotiation"`
}

type PullCaptureTracksInput struct {
	Metadata         OperationMetadata `json:"metadata"`
	Connection       ProviderReference `json:"connection"`
	Tracks           []CaptureTrack    `json:"tracks"`
	LocalDescription *Description      `json:"local_description,omitempty"`
}

type PullCaptureTracksResult struct {
	Connection  CaptureConnection    `json:"connection"`
	Tracks      []PulledCaptureTrack `json:"tracks"`
	Negotiation Negotiation          `json:"negotiation"`
}

type RenegotiateCaptureConnectionInput struct {
	Metadata      OperationMetadata `json:"metadata"`
	Connection    ProviderReference `json:"connection"`
	NegotiationID ProviderReference `json:"negotiation_id"`
	Description   Description       `json:"description"`
}

type RenegotiateCaptureConnectionResult struct {
	Connection  CaptureConnection `json:"connection"`
	Negotiation Negotiation       `json:"negotiation"`
}

type InspectCaptureConnectionInput struct {
	Metadata   OperationMetadata    `json:"metadata"`
	Connection ProviderReference    `json:"connection"`
	Tracks     []PulledCaptureTrack `json:"tracks,omitempty"`
}

type InspectCaptureConnectionResult struct {
	Connection  CaptureConnection      `json:"connection"`
	State       CaptureConnectionState `json:"state"`
	Tracks      []ObservedCaptureTrack `json:"tracks"`
	Negotiation Negotiation            `json:"negotiation"`
}

type CloseCaptureTracksInput struct {
	Metadata   OperationMetadata    `json:"metadata"`
	Connection ProviderReference    `json:"connection"`
	Tracks     []PulledCaptureTrack `json:"tracks"`
}

type CloseCaptureTracksResult struct {
	Connection  CaptureConnection    `json:"connection"`
	Tracks      []PulledCaptureTrack `json:"tracks"`
	Negotiation Negotiation          `json:"negotiation"`
}

type CloseCaptureConnectionInput struct {
	Metadata   OperationMetadata    `json:"metadata"`
	Connection ProviderReference    `json:"connection"`
	Tracks     []PulledCaptureTrack `json:"tracks,omitempty"`
	Force      bool                 `json:"force"`
}

type CloseCaptureConnectionResult struct {
	Connection CaptureConnection `json:"connection"`
	Closed     bool              `json:"closed"`
}

// CapturePlane is the provider-neutral signaling port used by recorder
// workers. Cloudflare SFU and mediasoup adapters implement this interface.
type CapturePlane interface {
	CreateCaptureConnection(context.Context, CreateCaptureConnectionInput) (CreateCaptureConnectionResult, error)
	PullCaptureTracks(context.Context, PullCaptureTracksInput) (PullCaptureTracksResult, error)
	RenegotiateCaptureConnection(context.Context, RenegotiateCaptureConnectionInput) (RenegotiateCaptureConnectionResult, error)
	InspectCaptureConnection(context.Context, InspectCaptureConnectionInput) (InspectCaptureConnectionResult, error)
	CloseCaptureTracks(context.Context, CloseCaptureTracksInput) (CloseCaptureTracksResult, error)
	CloseCaptureConnection(context.Context, CloseCaptureConnectionInput) (CloseCaptureConnectionResult, error)
}

func (k OperationKind) String() string { return string(k) }

func (s CaptureConnectionState) String() string { return string(s) }

func (s TrackSource) String() string { return string(s) }

func (k TrackKind) String() string { return string(k) }

func (l TrackLayer) String() string { return string(l) }

func (r NegotiationRequirement) String() string { return string(r) }

func (i CaptureIdentity) String() string {
	return fmt.Sprintf("tenant=%s space=%s episode=%s recording=%s", i.TenantID, i.SpaceID, i.EpisodeID, i.RecordingID)
}
