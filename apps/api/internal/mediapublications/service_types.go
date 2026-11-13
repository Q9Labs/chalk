package mediapublications

import (
	"context"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type Repository interface {
	AppendPublicationObservation(context.Context, provideroperations.ObservationInput, PublicationParticipant) (provideroperations.Observation, error)
	AppendObservation(context.Context, provideroperations.ObservationInput) (provideroperations.Observation, error)
	ListObservations(context.Context, utilities.ID, utilities.ID, *provideroperations.Cursor, int) (provideroperations.ObservationPage, error)
	ListPublicationParticipants(context.Context, utilities.ID, utilities.ID) ([]PublicationParticipant, error)
}

type PublicationParticipant struct {
	ID           utilities.ID
	Generation   int64
	ConnectionID string
}

type PublishedTrack struct {
	Source    mediaplane.PublicationSource
	MID       string
	TrackName string
}

type PublishedReference struct {
	Source        mediaplane.PublicationSource
	MID           string
	TrackName     string
	PublicationID string
}

type RecordInput struct {
	TenantID              utilities.ID
	EpisodeID             utilities.ID
	ParticipantID         utilities.ID
	ParticipantGeneration int64
	ConnectionID          string
	Tracks                []PublishedTrack
}

type CloseInput struct {
	TenantID              utilities.ID
	EpisodeID             utilities.ID
	ParticipantID         utilities.ID
	ParticipantGeneration int64
	ConnectionID          string
	MID                   string
	Source                mediaplane.PublicationSource
	PublicationID         string
}

type AvailabilityInput struct {
	TenantID      utilities.ID
	EpisodeID     utilities.ID
	ParticipantID utilities.ID
	Source        mediaplane.PublicationSource
	PublicationID string
	Enabled       bool
}

type CloseDecision struct {
	ProviderCloseRequired bool
}

type Snapshot struct {
	Incarnation  int64
	Sequence     int64
	Publications []provideroperations.Publication
}

type Registry interface {
	RecordPublishedTracks(context.Context, RecordInput) ([]PublishedReference, error)
	RecordPublicationAvailability(context.Context, AvailabilityInput) error
	PrepareClose(context.Context, CloseInput) (CloseDecision, error)
	RecordClosedPublication(context.Context, CloseInput) error
	Latest(context.Context, utilities.ID, utilities.ID) (Snapshot, error)
}

type RemoteTrackObserver interface {
	ObserveRemoteTracks(context.Context, RemoteTrackObservationInput) error
}
