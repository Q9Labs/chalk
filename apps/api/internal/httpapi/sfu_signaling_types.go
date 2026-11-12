package httpapi

import (
	"context"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type sfuTracksRequest struct {
	ConnectionID       string                         `json:"connection_id"`
	SessionDescription *mediaplane.SessionDescription `json:"session_description,omitempty"`
	Tracks             []mediaplane.Track             `json:"tracks"`
	// PullPublishedAudio asks the API to read the publication list and pull the other Participants' microphone and screen audio in this one request, so a joining client skips the list round trip. It carries no tracks.
	PullPublishedAudio bool `json:"pull_published_audio,omitempty"`
}

type sfuUpdateTracksRequest struct {
	ConnectionID string             `json:"connection_id"`
	Tracks       []mediaplane.Track `json:"tracks"`
}

type sfuRenegotiateRequest struct {
	ConnectionID       string                        `json:"connection_id"`
	SessionDescription mediaplane.SessionDescription `json:"session_description"`
}

type sfuCloseTracksRequest struct {
	ReceiveOnly        bool                           `json:"receive_only,omitempty"`
	ConnectionID       string                         `json:"connection_id"`
	SessionDescription *mediaplane.SessionDescription `json:"session_description,omitempty"`
	Tracks             []sfuCloseTrackRequest         `json:"tracks"`
	Force              bool                           `json:"force"`
}

type sfuCloseTrackRequest struct {
	Mid           string `json:"mid"`
	Source        string `json:"source"`
	PublicationID string `json:"publication_id"`
}

type sfuTracksEndpointRequest struct {
	AllowPartialRemoteTracks bool
	ReplacementCause         string
	TenantID                 utilities.ID
	SpaceID                  utilities.ID
	EpisodeID                utilities.ID
	ParticipantID            utilities.ID
	Body                     sfuTracksRequest
}

type sfuUpdateTracksEndpointRequest struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	EpisodeID     utilities.ID
	ParticipantID utilities.ID
	Body          sfuUpdateTracksRequest
}

type sfuRenegotiateEndpointRequest struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	EpisodeID     utilities.ID
	ParticipantID utilities.ID
	Body          sfuRenegotiateRequest
}

type sfuCloseTracksEndpointRequest struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	EpisodeID     utilities.ID
	ParticipantID utilities.ID
	Body          sfuCloseTracksRequest
}

type sfuRenegotiateResponse struct {
	Accepted bool `json:"accepted"`
}

type sfuPublicationsEndpointRequest struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	EpisodeID     utilities.ID
	ParticipantID utilities.ID
}

type sfuPublicationsResponse = mediaplane.PublicationList

type sfuSubscriptionResponse struct {
	Mid          string `json:"mid"`
	SessionID    string `json:"session_id"`
	TrackName    string `json:"track_name"`
	State        string `json:"state"`
	Reason       string `json:"reason,omitempty"`
	Revision     uint64 `json:"revision"`
	RequestedRID string `json:"requested_rid,omitempty"`
	EffectiveRID string `json:"effective_rid,omitempty"`
}

type sfuSubscriptionsResponse struct {
	Subscriptions []sfuSubscriptionResponse `json:"subscriptions"`
}

// EpisodeLookup provides the bounded read needed to ensure participant media
// routes refer to an Episode belonging to the requested Space.
type EpisodeLookup interface {
	GetEpisode(context.Context, utilities.ID, utilities.ID, utilities.ID) (episodes.Episode, error)
}

func tenantSpaceEpisodeParticipantIDsRequest(request *http.Request) (utilities.ID, utilities.ID, utilities.ID, utilities.ID, error) {
	tenantID, spaceID, episodeID, err := tenantSpaceEpisodeIDsRequest(request)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, utilities.ID{}, utilities.ID{}, err
	}
	participantID, err := routeID(request, "participant_id", apiErrorInvalidParticipantID)
	return tenantID, spaceID, episodeID, participantID, err
}

func tenantSpaceEpisodeParticipantParameters() []APIParameterContract {
	return []APIParameterContract{tenantIDParameter(), spaceIDParameter(), episodeIDParameter(), participantIDParameter()}
}
