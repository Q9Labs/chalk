package mediapublications

import (
	"context"
	"crypto/sha256"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type ListenerPullInput struct {
	ReceiveHealthEpisode
	ParticipantID         utilities.ID
	ParticipantGeneration int64
	ConnectionID          string
	Capture               ListenerPullCapture
	Requested             []mediaplane.Track
	Response              mediaplane.TracksResponse
	Err                   error
}

type ListenerPullCapture struct {
	snapshot receivePublicationSnapshot
	captured bool
}

func (s Service) CaptureListenerPull(episode ReceiveHealthEpisode) ListenerPullCapture {
	if s.receiveHealth == nil {
		return ListenerPullCapture{captured: true}
	}
	return ListenerPullCapture{snapshot: s.receiveHealth.publicationSnapshot(episode, s.receiveHealth.now()), captured: true}
}

type ListenerPullObserver interface {
	ObserveListenerPull(context.Context, ListenerPullInput)
}

func (s Service) ObserveListenerPull(_ context.Context, input ListenerPullInput) {
	remote := false
	for _, track := range input.Requested {
		remote = remote || track.Location == "remote"
	}
	if !remote {
		return
	}
	h := s.receiveHealth
	now := h.now()
	capture := input.Capture
	if !capture.captured {
		capture = s.CaptureListenerPull(input.ReceiveHealthEpisode)
	}
	snapshot := capture.snapshot
	key := receivePullKey{listener: input.ParticipantID, generation: input.ParticipantGeneration, connection: sha256.Sum256([]byte(input.ConnectionID))}
	pulls := make(map[receivePullKey]receivePull)
	for _, track := range input.Requested {
		if track.Location != "remote" {
			continue
		}
		key.publisher = sha256.Sum256([]byte(track.SessionID))
		key.track = sha256.Sum256([]byte(track.TrackName))
		key.publication = [32]byte{}
		if len(track.PublicationID) <= 4096 {
			if reference, err := ParseReference(track.PublicationID); err == nil && reference.ConnectionID == track.SessionID && reference.TrackName == track.TrackName {
				key.publication = sha256.Sum256([]byte(track.PublicationID))
			}
		}
		if key.publication == ([32]byte{}) {
			key.publication = snapshot.identities[receivePublicationKey{publisher: key.publisher, track: key.track}]
		}
		if key.publication == ([32]byte{}) && snapshot.identities != nil {
			continue
		}
		step, kind := listenerPullResult(track, input.Response, input.Err)
		pulls[key] = receivePull{since: now, step: step, errorKind: kind, commits: snapshot.commits}
		if len(pulls) == receiveHealthMaxPublications {
			break
		}
	}
	if len(pulls) == 0 {
		return
	}
	state := h.episode(input.ReceiveHealthEpisode)
	if state == nil {
		return
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	for key, pull := range pulls {
		previous, exists := state.pulls[key]
		if !exists && len(state.pulls) >= receiveHealthMaxPairs {
			state.truncated = true
			continue
		}
		if exists && now.Sub(previous.since) <= receiveHealthTTL {
			if previous.step == "pull_succeeded" {
				continue
			}
			pull.since = previous.since
		}
		state.pulls[key] = pull
	}
}

func listenerPullResult(request mediaplane.Track, response mediaplane.TracksResponse, err error) (string, string) {
	for _, failure := range response.TrackErrors {
		if failure.ConnectionID == request.SessionID && failure.TrackName == request.TrackName {
			return "pull_failed", boundedPullErrorKind(failure.Code)
		}
	}
	if err == nil || mediaplane.IsPartialRemoteTrackResponse(err) {
		for _, track := range response.Tracks {
			if track.Location == "remote" && track.SessionID == request.SessionID && track.TrackName == request.TrackName && track.Mid != "" {
				return "pull_succeeded", ""
			}
		}
	}
	if err != nil {
		return "pull_failed", "request_failed"
	}
	return "pull_failed", "missing_result"
}

func boundedPullErrorKind(kind string) string {
	switch kind {
	case "invalid_request", "invalid_track", "connection_not_found", "connection_not_connected", "track_not_found", "empty_track_error", "unauthorized", "rate_limited", "timeout", "transport_error", "client_canceled", "plane_unavailable", "invalid_json", "invalid_contract", "provider_rejected", "provider_internal":
		return kind
	default:
		return "unknown"
	}
}
