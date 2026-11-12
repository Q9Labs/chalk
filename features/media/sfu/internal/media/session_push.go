package media

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

func classifyTracks(request protocol.TracksRequest) (local bool, err error) {
	description := request.SessionDescription
	if len(request.Tracks) == 0 && description != nil && description.Type == "offer" && description.SDP != "" {
		// A push of no tracks renegotiates the connection, as an ICE restart does.
		return true, nil
	}
	if len(request.Tracks) == 0 || len(request.Tracks) > protocol.MaxTracksPerRequest {
		return false, fmt.Errorf("%w: a request carries 1 to %d tracks", ErrInvalidRequest, protocol.MaxTracksPerRequest)
	}
	local = request.Tracks[0].Location == protocol.LocationLocal
	for index, track := range request.Tracks {
		if err := checkRequestedTrack(index, track, local); err != nil {
			return false, err
		}
	}
	switch {
	case local && (description == nil || description.Type != "offer" || description.SDP == ""):
		return false, fmt.Errorf("%w: a push needs an offer", ErrInvalidRequest)
	case !local && description != nil:
		return false, fmt.Errorf("%w: a pull carries no SDP; the server offers", ErrInvalidRequest)
	}
	return local, nil
}

// checkRequestedTrack checks one track of a push (local) or pull (remote) request.
func checkRequestedTrack(index int, track protocol.Track, local bool) error {
	if track.TrackName == "" {
		return fmt.Errorf("%w: tracks[%d].trackName is required", ErrInvalidRequest, index)
	}
	want := protocol.LocationRemote
	if local {
		want = protocol.LocationLocal
	}
	switch {
	case track.Location != want:
		return fmt.Errorf("%w: tracks[%d].location must be %q; a request is all local or all remote", ErrInvalidRequest, index, want)
	case local && (track.Mid == "" || !validSource(track.Source)):
		return fmt.Errorf("%w: tracks[%d] needs a mid and a source of microphone, camera, screen or screen_audio", ErrInvalidRequest, index)
	case !local && track.SessionID == "":
		return fmt.Errorf("%w: tracks[%d].sessionId is required for a remote track", ErrInvalidRequest, index)
	}
	return nil
}

func validSource(source string) bool {
	return slices.Contains([]string{"microphone", "camera", "screen", "screen_audio"}, source)
}

func (s *Session) push(ctx context.Context, request protocol.TracksRequest) (protocol.TracksResponse, error) {
	sections, existing, err := s.checkOffer(request)
	if err != nil {
		if errors.Is(err, ErrInvalidRequest) || errors.Is(err, ErrCapacityExceeded) {
			return protocol.TracksResponse{}, err
		}
		return protocol.TracksResponse{}, s.failNegotiation("read the offer", err)
	}
	if err := s.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: request.SessionDescription.SDP}); err != nil {
		return protocol.TracksResponse{}, s.failNegotiation("apply the offer", err)
	}
	response, refused, err := s.registerPublications(request.Tracks, sections, existing)
	if err != nil {
		return protocol.TracksResponse{}, err
	}
	// Pion has already created a transceiver for each refused section. Stop it so it carries
	// no media, and the answer marks the section inactive.
	for _, transceiver := range refused {
		if err := transceiver.Stop(); err != nil {
			s.node.log.Warn("stop refused section", "connection_id", s.id, "error", err)
		}
	}

	answer, err := s.pc.CreateAnswer(nil)
	if err == nil {
		err = s.pc.SetLocalDescription(answer)
	}
	if err != nil {
		return protocol.TracksResponse{}, s.failNegotiation("answer the offer", err)
	}
	description, err := s.completeLocalDescription(ctx)
	if err != nil {
		return protocol.TracksResponse{}, s.failNegotiation("gather ICE candidates", err)
	}
	response.SessionDescription = description
	return response, nil
}

// checkOffer bounds the offer before Pion sees it: its size, and the sections it adds. Every
// new section must belong to a track of the request, and the new tracks must fit the
// publication and section limits, so the peer connection never allocates for an offer the
// node would not accept. It returns the parsed sections and the MIDs the connection already has.
func (s *Session) checkOffer(request protocol.TracksRequest) (map[string]offerSection, map[string]bool, error) {
	sections, err := parseOffer(request.SessionDescription.SDP)
	if err != nil {
		return nil, nil, err
	}
	named := make(map[string]bool, len(request.Tracks))
	for _, track := range request.Tracks {
		named[track.Mid] = true
	}
	transceivers := s.pc.GetTransceivers()
	existing := make(map[string]bool, len(transceivers))
	for _, transceiver := range transceivers {
		existing[transceiver.Mid()] = true
	}
	added := 0
	for mid := range sections {
		if existing[mid] {
			continue
		}
		if !named[mid] {
			return nil, nil, fmt.Errorf("%w: the offer has a section that no track of the request names", ErrInvalidRequest)
		}
		added++
	}
	if len(transceivers)+added > s.transceiverLimit() {
		return nil, nil, fmt.Errorf("%w: too many media sections on this connection", ErrCapacityExceeded)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	fresh := make(map[string]bool, len(request.Tracks))
	for _, track := range request.Tracks {
		if s.published[track.Mid] == nil && s.publishedByName(track.TrackName) == nil {
			fresh[track.Mid] = true
		}
	}
	if len(s.published)+len(fresh) > s.node.cfg.MaxPublishedPerSession {
		return nil, nil, fmt.Errorf("%w: too many published tracks", ErrCapacityExceeded)
	}
	return sections, existing, nil
}

// transceiverLimit is the most media sections one connection may ever hold.
func (s *Session) transceiverLimit() int {
	return sectionHeadroom * (s.node.cfg.MaxPublishedPerSession + s.subscriptionLimit())
}

// registerPublication records one pushed track. The caller holds s.mu. It returns the
// section's transceiver and a track error code when the track cannot be published.
func (s *Session) registerPublication(track protocol.Track, sections map[string]offerSection) (*webrtc.RTPTransceiver, string, string) {
	transceiver := s.receiveTransceiver(track.Mid)
	section, offered := sections[track.Mid]
	if transceiver == nil || !offered || !section.sending {
		return transceiver, protocol.TrackCodeInvalid, "mid is not a sending section of the offer"
	}
	if !section.supports(transceiver.Kind()) {
		return transceiver, protocol.TrackCodeInvalid, "the section does not offer a supported codec: Opus for audio, VP8 for video"
	}
	if s.retired[track.Mid] {
		return transceiver, protocol.TrackCodeInvalid, "mid was closed; publish on a new section"
	}
	if s.published[track.Mid] != nil || s.publishedByName(track.TrackName) != nil {
		return transceiver, protocol.TrackCodeDuplicate, "mid or track name is already published"
	}
	if transceiver.Kind() == webrtc.RTPCodecTypeVideo && track.Source != sourceScreen && s.cameras() >= s.node.cfg.CamerasPerParticipant {
		s.node.refuseCamera(s)
		return transceiver, protocol.TrackCodeLimitExceeded, "the Participant already publishes the cameras this node reserves for"
	}
	pub, err := newPublication(s, track, transceiver.Kind())
	if err != nil {
		return transceiver, protocol.TrackCodeLimitExceeded, "the node's source table is full"
	}
	if track.Source == sourceScreen {
		if code, message := s.node.claimScreen(s); code != "" {
			return transceiver, code, message
		}
	}
	s.published[track.Mid] = pub
	return transceiver, "", ""
}

// cameras counts the session's camera publications. The caller holds s.mu.
func (s *Session) cameras() int {
	count := 0
	for _, pub := range s.published {
		if pub.video() && pub.source != sourceScreen {
			count++
		}
	}
	return count
}

// receiveTransceiver finds the section where the client sends to the SFU.
func (s *Session) receiveTransceiver(mid string) *webrtc.RTPTransceiver {
	for _, transceiver := range s.pc.GetTransceivers() {
		if transceiver.Mid() == mid && transceiver.Direction() == webrtc.RTPTransceiverDirectionRecvonly {
			return transceiver
		}
	}
	return nil
}

// publishedByName returns the live publication with that name. The caller holds s.mu.
func (s *Session) publishedByName(name string) *publication {
	for _, pub := range s.published {
		if pub.name == name {
			return pub
		}
	}
	return nil
}

func (s *Session) publication(name string) *publication {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.publishedByName(name)
}

// registerPublications registers each pushed track under the session's lock. It returns the
// transceivers of sections it refused, which the caller stops after the lock is gone.
func (s *Session) registerPublications(tracks []protocol.Track, sections map[string]offerSection, existing map[string]bool) (response protocol.TracksResponse, refused []*webrtc.RTPTransceiver, err error) {
	named := make(map[string]bool, len(tracks))
	s.mu.Lock()
	defer s.mu.Unlock()
	// A Close that ran while the offer was applied has already released this session's
	// publications, so a publication registered now, and its screen claim, would never be released.
	if s.closed {
		return response, nil, ErrSessionGone
	}
	for _, track := range tracks {
		if named[track.Mid] {
			response.TrackErrors = append(response.TrackErrors, protocol.TrackError{TrackName: track.TrackName, Code: protocol.TrackCodeDuplicate, Message: "the request names this mid twice"})
			continue
		}
		named[track.Mid] = true
		transceiver, code, message := s.registerPublication(track, sections)
		if code != "" {
			response.TrackErrors = append(response.TrackErrors, protocol.TrackError{TrackName: track.TrackName, Code: code, Message: message})
			if transceiver != nil && !existing[track.Mid] && s.published[track.Mid] == nil {
				refused = append(refused, transceiver)
				// A stopped transceiver never receives again, so a retry must use a new section.
				s.retired[track.Mid] = true
			}
			continue
		}
		response.Tracks = append(response.Tracks, protocol.Track{Location: protocol.LocationLocal, Mid: track.Mid, TrackName: track.TrackName, Source: track.Source})
	}
	return response, refused, nil
}
