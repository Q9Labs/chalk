package httpapi

import (
	"context"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// The unified signalling route serves every SFU operation from one URL. A browser
// caches a CORS preflight per URL, so one URL pays one preflight for a whole join
// where the per-operation routes paid one each. Each operation runs the same
// function as its per-operation route and keeps that route's quota and errors.
const (
	sfuSignalOpPublications  = "publications"
	sfuSignalOpSubscriptions = "subscriptions"
	sfuSignalOpTracks        = "tracks"
	sfuSignalOpTracksClose   = "tracks_close"
	sfuSignalOpTracksUpdate  = "tracks_update"
	sfuSignalOpRenegotiate   = "renegotiate"
)

// sfuSignalRequest is the body of the unified route. Each operation reads the
// fields its per-operation route reads from its body or query string.
type sfuSignalRequest struct {
	Op                       string                         `json:"op"`
	ConnectionID             string                         `json:"connection_id,omitempty"`
	SessionDescription       *mediaplane.SessionDescription `json:"session_description,omitempty"`
	Tracks                   []mediaplane.Track             `json:"tracks,omitempty"`
	CloseTracks              []sfuCloseTrackRequest         `json:"close_tracks,omitempty"`
	Force                    bool                           `json:"force,omitempty"`
	ReceiveOnly              bool                           `json:"receive_only,omitempty"`
	AllowPartialRemoteTracks bool                           `json:"allow_partial_remote_tracks,omitempty"`
	ReplacementCause         string                         `json:"replacement_cause,omitempty"`
	// PullPublishedAudio is the tracks operation's combined join pull: it carries no tracks.
	PullPublishedAudio bool `json:"pull_published_audio,omitempty"`
}

// SFUSignalFieldEnum lists the values of the unified request's enumerated fields, for the generated contract.
func SFUSignalFieldEnum(fieldName string) []string {
	switch fieldName {
	case "op":
		return []string{sfuSignalOpPublications, sfuSignalOpSubscriptions, sfuSignalOpTracks, sfuSignalOpTracksClose, sfuSignalOpTracksUpdate, sfuSignalOpRenegotiate}
	case "replacement_cause":
		return observability.MediaReplacementCauses()
	default:
		return nil
	}
}

// sfuSignalResponse is the contract of the unified route's answer. The body of
// each operation is exactly its per-operation route's body, so this is their
// union with every field optional: tracks, tracks_update and tracks_close answer
// sessionDescription, tracks, trackErrors and requiresImmediateRenegotiation;
// renegotiate answers accepted; publications and subscriptions answer their lists.
// Publications is an array for the publications operation, and an object holding
// incarnation, sequence and that array for a tracks operation that pulled published audio.
type sfuSignalResponse struct {
	SessionDescription             *mediaplane.SessionDescription `json:"sessionDescription,omitempty"`
	Tracks                         []sfuSignalTrack               `json:"tracks,omitempty"`
	TrackErrors                    []mediaplane.TrackError        `json:"trackErrors,omitempty"`
	RequiresImmediateRenegotiation bool                           `json:"requiresImmediateRenegotiation,omitempty"`
	Accepted                       bool                           `json:"accepted,omitempty"`
	Incarnation                    int64                          `json:"incarnation,omitempty"`
	Sequence                       int64                          `json:"sequence,omitempty"`
	Publications                   any                            `json:"publications,omitempty"`
	Subscriptions                  []sfuSubscriptionResponse      `json:"subscriptions,omitempty"`
}

// sfuSignalTrack is a track of a tracks or tracks_update answer, or a closed track of a tracks_close answer.
type sfuSignalTrack struct {
	Simulcast     *mediaplane.Simulcast `json:"simulcast,omitempty"`
	Location      string                `json:"location,omitempty"`
	Mid           string                `json:"mid,omitempty"`
	TrackName     string                `json:"trackName,omitempty"`
	SessionID     string                `json:"sessionId,omitempty"`
	Source        string                `json:"source,omitempty"`
	PublicationID string                `json:"publication_id,omitempty"`
	Paused        *bool                 `json:"paused,omitempty"`
}

type sfuSignalEndpointRequest struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	EpisodeID     utilities.ID
	ParticipantID utilities.ID
	Body          sfuSignalRequest
}

func sfuSignalEndpoint(spaces SpaceService, episodeLookup EpisodeLookup, tenants TenantService, media MediaPlaneResolver, publications mediapublications.Registry) Endpoint[sfuSignalEndpointRequest, any] {
	return Post(
		"/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/media/sfu/signal",
		"signalCloudflareSFU",
		decodeSFUSignalRequest,
		func(ctx context.Context, request sfuSignalEndpointRequest) (any, error) {
			return signalSFU(ctx, request, spaces, episodeLookup, tenants, media, publications)
		},
	).
		Auth(APIAuthParticipantMedia).
		RateLimitFor(authenticatedWriteRateLimit, sfuSignalRateLimit).
		Parameters(tenantSpaceEpisodeParticipantParameters()...).
		RequestBody("CloudflareSFUSignalRequest", sfuSignalRequest{}).
		Responds(http.StatusOK, "CloudflareSFUSignalAPIResponse", sfuSignalResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidParticipantID, apiErrorEpisodeNotFound, apiErrorMediaPlaneUnavailable, apiErrorMediaConnectionNotFound, apiErrorRateLimited)...).
		ErrorRules(episodeLifecycleRules)
}

// sfuSignalRateLimit charges the quota each per-operation route charges: the
// writes share the authenticated write quota and the two reads have none.
func sfuSignalRateLimit(request sfuSignalEndpointRequest) (ratelimit.Policy, bool) {
	switch request.Body.Op {
	case sfuSignalOpPublications, sfuSignalOpSubscriptions:
		return ratelimit.Policy{}, false
	default:
		return authenticatedWriteRateLimit, true
	}
}

func signalSFU(ctx context.Context, request sfuSignalEndpointRequest, spaces SpaceService, episodeLookup EpisodeLookup, tenants TenantService, media MediaPlaneResolver, publications mediapublications.Registry) (any, error) {
	body := request.Body
	switch body.Op {
	case sfuSignalOpPublications:
		return nilOnError(listSFUPublications(ctx, sfuPublicationsEndpointRequest{TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID, ParticipantID: request.ParticipantID}, spaces, episodeLookup, tenants, media, publications))
	case sfuSignalOpSubscriptions:
		return nilOnError(listSFUSubscriptions(ctx, sfuPublicationsEndpointRequest{TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID, ParticipantID: request.ParticipantID}, spaces, episodeLookup, tenants, media))
	case sfuSignalOpTracks:
		return nilOnError(signalSFUTracks(ctx, sfuTracksEndpointRequest{
			AllowPartialRemoteTracks: body.AllowPartialRemoteTracks, ReplacementCause: body.ReplacementCause,
			TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID, ParticipantID: request.ParticipantID,
			Body: sfuTracksRequest{ConnectionID: body.ConnectionID, SessionDescription: body.SessionDescription, Tracks: body.Tracks, PullPublishedAudio: body.PullPublishedAudio},
		}, spaces, episodeLookup, tenants, media, publications))
	case sfuSignalOpTracksClose:
		return nilOnError(signalSFUCloseTracks(ctx, sfuCloseTracksEndpointRequest{
			TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID, ParticipantID: request.ParticipantID,
			Body: sfuCloseTracksRequest{ReceiveOnly: body.ReceiveOnly, ConnectionID: body.ConnectionID, SessionDescription: body.SessionDescription, Tracks: body.CloseTracks, Force: body.Force},
		}, spaces, episodeLookup, tenants, media, publications))
	case sfuSignalOpTracksUpdate:
		return nilOnError(signalSFUUpdateTracks(ctx, sfuUpdateTracksEndpointRequest{
			TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID, ParticipantID: request.ParticipantID,
			Body: sfuUpdateTracksRequest{ConnectionID: body.ConnectionID, Tracks: body.Tracks},
		}, spaces, episodeLookup, tenants, media, publications))
	case sfuSignalOpRenegotiate:
		return nilOnError(signalSFURenegotiate(ctx, sfuRenegotiateEndpointRequest{
			TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID, ParticipantID: request.ParticipantID,
			Body: sfuRenegotiateRequest{ConnectionID: body.ConnectionID, SessionDescription: sessionDescriptionOf(body.SessionDescription)},
		}, spaces, episodeLookup, tenants, media))
	default:
		return nil, apiErrorInvalidRequest
	}
}

func nilOnError[T any](response T, err error) (any, error) {
	if err != nil {
		return nil, err
	}
	return response, nil
}

func sessionDescriptionOf(description *mediaplane.SessionDescription) mediaplane.SessionDescription {
	if description == nil {
		return mediaplane.SessionDescription{}
	}
	return *description
}

func decodeSFUSignalRequest(request *http.Request) (sfuSignalEndpointRequest, error) {
	tenantID, spaceID, episodeID, participantID, err := tenantSpaceEpisodeParticipantIDsRequest(request)
	if err != nil {
		return sfuSignalEndpointRequest{}, err
	}
	body, err := decodeJSONBody[sfuSignalRequest](request)
	if err != nil {
		return sfuSignalEndpointRequest{}, err
	}
	return sfuSignalEndpointRequest{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID, Body: body}, nil
}
