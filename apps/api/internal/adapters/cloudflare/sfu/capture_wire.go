package sfu

import "strings"

// providerDescription is kept separate from the media-plane envelope so
// the provider-specific shape cannot cross the captureplane port.
type providerDescription struct {
	SDP  string `json:"sdp"`
	Type string `json:"type"`
}

type providerConnectionEnvelope struct {
	ConnectionReference string `json:"sessionId,omitempty"`
}

type providerDescriptionEnvelope struct {
	Description *providerDescription `json:"sessionDescription,omitempty"`
}

type captureCreateConnectionResponse struct {
	providerConnectionEnvelope
	providerDescriptionEnvelope
	ErrorCode        string `json:"errorCode"`
	ErrorDescription string `json:"errorDescription"`
}

func (r *captureCreateConnectionResponse) providerError(operation string, statusCode int) error {
	if strings.TrimSpace(r.ErrorCode) == "" && strings.TrimSpace(r.ErrorDescription) == "" {
		return nil
	}
	return newProviderResponseFailure(operation, failureStageTopLevel, statusCode, r.ErrorCode, r.ErrorDescription, 0, 0)
}

type captureSimulcast struct {
	PreferredRID string `json:"preferredRid,omitempty"`
}

type captureTrackRequest struct {
	providerConnectionEnvelope
	Location  string            `json:"location"`
	Mid       string            `json:"mid,omitempty"`
	TrackName string            `json:"trackName"`
	Kind      string            `json:"kind,omitempty"`
	Simulcast *captureSimulcast `json:"simulcast,omitempty"`
}

type captureTracksRequest struct {
	providerDescriptionEnvelope
	Tracks       []captureTrackRequest `json:"tracks"`
	AutoDiscover bool                  `json:"autoDiscover"`
}

type captureTrackResult struct {
	providerConnectionEnvelope
	Location         string            `json:"location"`
	Mid              string            `json:"mid"`
	TrackName        string            `json:"trackName"`
	Kind             string            `json:"kind"`
	Simulcast        *captureSimulcast `json:"simulcast,omitempty"`
	ErrorCode        string            `json:"errorCode"`
	ErrorDescription string            `json:"errorDescription"`
}

type captureTracksResponse struct {
	providerDescriptionEnvelope
	ErrorCode                      string               `json:"errorCode"`
	ErrorDescription               string               `json:"errorDescription"`
	Tracks                         []captureTrackResult `json:"tracks"`
	RequiresImmediateRenegotiation bool                 `json:"requiresImmediateRenegotiation"`
}

func (r *captureTracksResponse) providerError(operation string, statusCode int) error {
	if strings.TrimSpace(r.ErrorCode) != "" || strings.TrimSpace(r.ErrorDescription) != "" {
		return newProviderResponseFailure(operation, failureStageTopLevel, statusCode, r.ErrorCode, r.ErrorDescription, len(r.Tracks), captureTrackFailureCount(r.Tracks))
	}
	for _, track := range r.Tracks {
		if strings.TrimSpace(track.ErrorCode) != "" || strings.TrimSpace(track.ErrorDescription) != "" {
			failure := newProviderResponseFailure(operation, failureStageTrack, statusCode, track.ErrorCode, track.ErrorDescription, len(r.Tracks), captureTrackFailureCount(r.Tracks))
			failure.trackCode = boundedCaptureTrackCode(track.ErrorCode)
			return failure
		}
	}
	return nil
}

func boundedCaptureTrackCode(raw string) string {
	code := strings.ToLower(strings.TrimSpace(raw))
	if len(code) == 0 || len(code) > 64 || !strings.Contains(code, "_") {
		return ""
	}
	for _, char := range code {
		if char != '_' && (char < 'a' || char > 'z') && (char < '0' || char > '9') {
			return ""
		}
	}
	if code[0] < 'a' || code[0] > 'z' {
		return ""
	}
	return code
}

type captureRenegotiateRequest struct {
	providerDescriptionEnvelope
}

type captureRenegotiateResponse struct {
	providerDescriptionEnvelope
	ErrorCode        string `json:"errorCode"`
	ErrorDescription string `json:"errorDescription"`
}

func (r *captureRenegotiateResponse) providerError(operation string, statusCode int) error {
	if strings.TrimSpace(r.ErrorCode) == "" && strings.TrimSpace(r.ErrorDescription) == "" {
		return nil
	}
	return newProviderResponseFailure(operation, failureStageTopLevel, statusCode, r.ErrorCode, r.ErrorDescription, 0, 0)
}

type captureCloseTrack struct {
	Mid string `json:"mid"`
}

type captureCloseTrackResult struct {
	Mid              string `json:"mid"`
	ErrorCode        string `json:"errorCode"`
	ErrorDescription string `json:"errorDescription"`
}

type captureCloseTracksRequest struct {
	Tracks []captureCloseTrack `json:"tracks"`
	Force  bool                `json:"force"`
}

type captureCloseTracksResponse struct {
	providerDescriptionEnvelope
	ErrorCode                      string                    `json:"errorCode"`
	ErrorDescription               string                    `json:"errorDescription"`
	Tracks                         []captureCloseTrackResult `json:"tracks"`
	RequiresImmediateRenegotiation bool                      `json:"requiresImmediateRenegotiation"`
}

func (r *captureCloseTracksResponse) providerError(operation string, statusCode int) error {
	if strings.TrimSpace(r.ErrorCode) != "" || strings.TrimSpace(r.ErrorDescription) != "" {
		return newProviderResponseFailure(operation, failureStageTopLevel, statusCode, r.ErrorCode, r.ErrorDescription, len(r.Tracks), captureCloseTrackFailureCount(r.Tracks))
	}
	return nil
}

type captureObservedTrack struct {
	providerConnectionEnvelope
	Location         string `json:"location"`
	Mid              string `json:"mid"`
	TrackName        string `json:"trackName"`
	Status           string `json:"status"`
	ErrorCode        string `json:"errorCode"`
	ErrorDescription string `json:"errorDescription"`
}

type captureInspectResponse struct {
	ErrorCode        string                 `json:"errorCode"`
	ErrorDescription string                 `json:"errorDescription"`
	Tracks           []captureObservedTrack `json:"tracks"`
}

func (r *captureInspectResponse) providerError(operation string, statusCode int) error {
	if strings.TrimSpace(r.ErrorCode) == "" && strings.TrimSpace(r.ErrorDescription) == "" {
		return nil
	}
	return newProviderResponseFailure(operation, failureStageTopLevel, statusCode, r.ErrorCode, r.ErrorDescription, len(r.Tracks), 0)
}

type captureTrackKey struct {
	owner string
	track string
}

const (
	captureReplayCapacity   = 1024
	providerConnectionsPath = "/sessions"
)
