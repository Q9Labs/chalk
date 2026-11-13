package chalksfu

import "github.com/q9labs/chalk/apps/api/internal/mediaplane"

func wireDescriptionOf(description *mediaplane.SessionDescription) *wireDescription {
	if description == nil {
		return nil
	}
	return &wireDescription{SDP: description.SDP, Type: description.Type}
}

func descriptionOf(description *wireDescription) *mediaplane.SessionDescription {
	if description == nil {
		return nil
	}
	return &mediaplane.SessionDescription{SDP: description.SDP, Type: description.Type}
}

func wireTracksOf(tracks []mediaplane.Track) []wireTrack {
	out := make([]wireTrack, 0, len(tracks))
	for _, track := range tracks {
		wired := wireTrack{Location: track.Location, Mid: track.Mid, TrackName: track.TrackName, SessionID: track.SessionID, Source: string(track.Source), Paused: track.Paused != nil && *track.Paused}
		if track.Simulcast != nil {
			wired.Simulcast = &wireSimulcast{PreferredRID: track.Simulcast.PreferredRID, PriorityOrdering: track.Simulcast.PriorityOrdering, RIDNotAvailable: track.Simulcast.RIDNotAvailable}
		}
		out = append(out, wired)
	}
	return out
}

func tracksResponseOf(connectionID string, response wireTracksResponse) mediaplane.TracksResponse {
	out := mediaplane.TracksResponse{
		SessionDescription:             descriptionOf(response.SessionDescription),
		RequiresImmediateRenegotiation: response.RequiresImmediateRenegotiation,
	}
	for _, track := range response.Tracks {
		out.Tracks = append(out.Tracks, mediaplane.Track{Location: track.Location, Mid: track.Mid, TrackName: track.TrackName, SessionID: track.SessionID, Source: mediaplane.PublicationSource(track.Source)})
	}
	for _, failed := range response.TrackErrors {
		// A pull error names the publisher's connection, as Cloudflare's does, so
		// clients match it to the publication they asked for. A push error names none.
		owner := failed.SessionID
		if owner == "" {
			owner = connectionID
		}
		out.TrackErrors = append(out.TrackErrors, mediaplane.TrackError{ConnectionID: owner, TrackName: failed.TrackName, Code: failed.Code, PublicationMissing: failed.Code == "track_not_found"})
	}
	return out
}

func iceServersOf(urls []string) []mediaplane.ICEServer {
	if len(urls) == 0 {
		return []mediaplane.ICEServer{}
	}
	return []mediaplane.ICEServer{{URLs: urls}}
}
