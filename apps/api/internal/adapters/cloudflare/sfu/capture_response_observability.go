package sfu

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

const maxCaptureResponseSnapshotBytes = 4096

// Retain the documented response shape, never SDP, identifiers or unknown fields.
// Missing identity fields stay absent so the next incident can become a fixture.
func captureResponseSnapshot(payload []byte) string {
	var response struct {
		ErrorCode        *string `json:"errorCode,omitempty"`
		ErrorDescription *string `json:"errorDescription,omitempty"`
		Description      *struct {
			Type string `json:"type"`
			SDP  string `json:"sdp"`
		} `json:"sessionDescription,omitempty"`
		RequiresImmediateRenegotiation *bool `json:"requiresImmediateRenegotiation,omitempty"`
		Tracks                         []struct {
			SessionID        *string `json:"sessionId,omitempty"`
			TrackName        *string `json:"trackName,omitempty"`
			MID              *string `json:"mid,omitempty"`
			Location         *string `json:"location,omitempty"`
			ErrorCode        *string `json:"errorCode,omitempty"`
			ErrorDescription *string `json:"errorDescription,omitempty"`
		} `json:"tracks"`
		OmittedTracks int `json:"omittedTracks,omitempty"`
	}
	if err := json.Unmarshal(payload, &response); err != nil {
		return ""
	}
	response.OmittedTracks = 0
	if response.Description != nil {
		if response.Description.Type != "offer" && response.Description.Type != "answer" {
			response.Description.Type = "[redacted]"
		}
		response.Description.SDP = "[redacted]"
	}
	response.ErrorCode = captureSnapshotCode(response.ErrorCode)
	if response.ErrorDescription != nil {
		*response.ErrorDescription = observableProviderMessage(*response.ErrorDescription)
	}
	if len(response.Tracks) > 16 {
		response.OmittedTracks = len(response.Tracks) - 16
		response.Tracks = response.Tracks[:16]
	}
	for i := range response.Tracks {
		track := &response.Tracks[i]
		for _, identity := range []*string{track.SessionID, track.TrackName, track.MID} {
			if identity != nil {
				digest := sha256.Sum256([]byte(*identity))
				*identity = "redacted-" + hex.EncodeToString(digest[:8])
			}
		}
		if track.Location != nil && *track.Location != "local" && *track.Location != "remote" {
			*track.Location = "[redacted]"
		}
		track.ErrorCode = captureSnapshotCode(track.ErrorCode)
		if track.ErrorDescription != nil {
			*track.ErrorDescription = observableProviderMessage(*track.ErrorDescription)
		}
	}
	for {
		encoded, err := json.Marshal(response)
		if err != nil {
			return ""
		}
		if len(encoded) <= maxCaptureResponseSnapshotBytes {
			return string(encoded)
		}
		response.Tracks = response.Tracks[:len(response.Tracks)-1]
		response.OmittedTracks++
	}
}

func captureSnapshotCode(code *string) *string {
	if code == nil {
		return nil
	}
	// Unknown codes can contain identifiers; retain only known provider codes.
	switch *code {
	case "", "not_found_track_error", "empty_track_error", "internal_error", "transport_unavailable_error":
	default:
		*code = "[redacted]"
	}
	return code
}
