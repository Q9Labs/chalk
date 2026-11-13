package sfu

import (
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

type httpClient interface {
	Do(*http.Request) (*http.Response, error)
}

type responseValidator interface {
	providerError(operation string, statusCode int) error
}

type providerErrorEnvelope struct {
	ErrorCode        string `json:"errorCode"`
	ErrorDescription string `json:"errorDescription"`
	Errors           []struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"errors"`
}

type createSessionResponse struct {
	SessionID string `json:"sessionId"`
}

type inspectSessionResponse struct {
	Tracks []struct {
		Location  string `json:"location"`
		Mid       string `json:"mid"`
		TrackName string `json:"trackName"`
		Status    string `json:"status"`
		SessionID string `json:"sessionId"`
	} `json:"tracks"`
	ErrorCode        string `json:"errorCode"`
	ErrorDescription string `json:"errorDescription"`
}

type tracksRequest struct {
	SessionDescription *mediaplane.SessionDescription `json:"sessionDescription,omitempty"`
	Tracks             []providerTrack                `json:"tracks"`
}

type providerTrack struct {
	Simulcast *mediaplane.Simulcast `json:"simulcast,omitempty"`
	Location  string                `json:"location"`
	Mid       string                `json:"mid,omitempty"`
	TrackName string                `json:"trackName"`
	SessionID string                `json:"sessionId,omitempty"`
}

type addTracksResponse struct {
	ErrorCode                      string                         `json:"errorCode"`
	ErrorDescription               string                         `json:"errorDescription"`
	SessionDescription             *mediaplane.SessionDescription `json:"sessionDescription,omitempty"`
	Tracks                         []addTrackResult               `json:"tracks"`
	RequiresImmediateRenegotiation bool                           `json:"requiresImmediateRenegotiation"`
	requestedTracks                []providerTrack
	requestedLocalTracks           []providerTrack
}

type addTrackResult struct {
	Location         string `json:"location"`
	Mid              string `json:"mid"`
	TrackName        string `json:"trackName"`
	SessionID        string `json:"sessionId"`
	ErrorCode        string `json:"errorCode"`
	ErrorDescription string `json:"errorDescription"`
}

type updateTracksResponse struct {
	ErrorCode                      string           `json:"errorCode"`
	ErrorDescription               string           `json:"errorDescription"`
	Tracks                         []addTrackResult `json:"tracks"`
	RequiresImmediateRenegotiation bool             `json:"requiresImmediateRenegotiation"`
	requestedTracks                []providerTrack
}

type renegotiateRequest struct {
	SessionDescription mediaplane.SessionDescription `json:"sessionDescription"`
}

type closeTracksRequest struct {
	SessionDescription *mediaplane.SessionDescription `json:"sessionDescription,omitempty"`
	Tracks             []closeTrack                   `json:"tracks"`
	Force              bool                           `json:"force"`
}

type closeTracksResponse struct {
	ErrorCode                      string                         `json:"errorCode"`
	ErrorDescription               string                         `json:"errorDescription"`
	SessionDescription             *mediaplane.SessionDescription `json:"sessionDescription,omitempty"`
	Tracks                         []closeTrackResult             `json:"tracks"`
	RequiresImmediateRenegotiation bool                           `json:"requiresImmediateRenegotiation"`
	requestedTracks                []mediaplane.CloseTrack
}

type closeTrack struct {
	Mid string `json:"mid"`
}

type closeTrackResult struct {
	Mid              string `json:"mid"`
	ErrorCode        string `json:"errorCode"`
	ErrorDescription string `json:"errorDescription"`
}
