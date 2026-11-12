package media

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// AddTracks pushes local tracks from a client offer, or pulls remote tracks
// and returns a server offer. A retry with the same operation ID returns the first result.
func (s *Session) AddTracks(ctx context.Context, request protocol.TracksRequest) (protocol.TracksResponse, error) {
	local, err := classifyTracks(request)
	if err != nil {
		return protocol.TracksResponse{}, err
	}
	s.opMu.Lock()
	defer s.opMu.Unlock()
	return once(s, request.OperationID, request, func() (protocol.TracksResponse, error) {
		if err := s.readyForNegotiation(); err != nil {
			return protocol.TracksResponse{}, err
		}
		if local {
			if !s.kind.publishes {
				return protocol.TracksResponse{}, fmt.Errorf("%w: a capture session only pulls", ErrUnsupportedOperation)
			}
			return s.push(ctx, request)
		}
		return s.pull(ctx, request)
	})
}

func (s *Session) readyForNegotiation() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case s.closed:
		return ErrSessionGone
	case s.pending != nil:
		return ErrNegotiationBusy
	}
	return nil
}

// Renegotiate applies the client's answer to the pending server offer. A retry with the same
// operation ID succeeds without applying the answer twice.
func (s *Session) Renegotiate(_ context.Context, request protocol.RenegotiateRequest) error {
	description := request.SessionDescription
	if description.Type != "answer" || description.SDP == "" {
		return fmt.Errorf("%w: renegotiate needs an answer", ErrInvalidRequest)
	}
	s.opMu.Lock()
	defer s.opMu.Unlock()
	_, err := once(s, request.OperationID, request, func() (struct{}, error) {
		s.mu.Lock()
		pending, closed := s.pending, s.closed
		s.mu.Unlock()
		switch {
		case closed:
			return struct{}{}, ErrSessionGone
		case pending == nil:
			return struct{}{}, ErrNoPendingOffer
		}
		if err := s.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: description.SDP}); err != nil {
			return struct{}{}, s.failNegotiation("apply the answer", err)
		}
		pending.timer.Stop()
		s.mu.Lock()
		s.pending = nil
		s.mu.Unlock()
		return struct{}{}, nil
	})
	return err
}

// CloseTracks closes tracks by MID. A MID that is already absent succeeds. A forced close needs
// no SDP. A negotiated close applies the client's offer, which stopped the tracks'
// transceivers, and returns the answer. ReceiveOnly closes subscriptions and never a publication.
func (s *Session) CloseTracks(ctx context.Context, request protocol.CloseTracksRequest) (protocol.CloseTracksResponse, error) {
	if len(request.Tracks) == 0 || len(request.Tracks) > protocol.MaxTracksPerRequest {
		return protocol.CloseTracksResponse{}, fmt.Errorf("%w: a request closes 1 to %d tracks", ErrInvalidRequest, protocol.MaxTracksPerRequest)
	}
	for index, track := range request.Tracks {
		if track.Mid == "" {
			return protocol.CloseTracksResponse{}, fmt.Errorf("%w: tracks[%d].mid is required", ErrInvalidRequest, index)
		}
	}
	description := request.SessionDescription
	switch {
	case request.Force && description != nil:
		return protocol.CloseTracksResponse{}, fmt.Errorf("%w: a forced close carries no SDP", ErrInvalidRequest)
	case !request.Force && (description == nil || description.Type != "offer" || description.SDP == ""):
		return protocol.CloseTracksResponse{}, fmt.Errorf("%w: a negotiated close needs the client's offer", ErrInvalidRequest)
	}
	s.opMu.Lock()
	defer s.opMu.Unlock()
	return once(s, request.OperationID, request, func() (protocol.CloseTracksResponse, error) {
		if request.Force {
			return s.closeForced(request), nil
		}
		return s.closeNegotiated(ctx, request)
	})
}

func (s *Session) closeForced(request protocol.CloseTracksRequest) protocol.CloseTracksResponse {
	var response protocol.CloseTracksResponse
	for _, track := range request.Tracks {
		response.Tracks = append(response.Tracks, protocol.ClosedTrack{Mid: track.Mid, AlreadyClosed: !s.closeMid(track.Mid, request.ReceiveOnly)})
	}
	return response
}

// closeNegotiated applies the client's offer first. The offer already carries the stopped
// sections, and Pion releases the matching senders and receivers while it applies it. Tracks the
// registry still holds are then released, and a section the offer did not stop stays open.
func (s *Session) closeNegotiated(ctx context.Context, request protocol.CloseTracksRequest) (protocol.CloseTracksResponse, error) {
	if err := s.readyForNegotiation(); err != nil {
		return protocol.CloseTracksResponse{}, err
	}
	sections, err := parseOffer(request.SessionDescription.SDP)
	if err != nil {
		return protocol.CloseTracksResponse{}, err
	}
	known := map[string]bool{}
	for _, transceiver := range s.pc.GetTransceivers() {
		known[transceiver.Mid()] = true
	}
	for mid := range sections {
		if !known[mid] {
			return protocol.CloseTracksResponse{}, fmt.Errorf("%w: a close offer cannot add a section", ErrInvalidRequest)
		}
	}
	if err := s.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: request.SessionDescription.SDP}); err != nil {
		return protocol.CloseTracksResponse{}, s.failNegotiation("apply the close offer", err)
	}
	var response protocol.CloseTracksResponse
	for _, track := range request.Tracks {
		response.Tracks = append(response.Tracks, protocol.ClosedTrack{Mid: track.Mid, AlreadyClosed: !s.closeMid(track.Mid, request.ReceiveOnly)})
	}
	answer, err := s.pc.CreateAnswer(nil)
	if err == nil {
		err = s.pc.SetLocalDescription(answer)
	}
	if err != nil {
		return protocol.CloseTracksResponse{}, s.failNegotiation("answer the close offer", err)
	}
	description, err := s.completeLocalDescription(ctx)
	if err != nil {
		return protocol.CloseTracksResponse{}, s.failNegotiation("gather ICE candidates", err)
	}
	response.SessionDescription = description
	return response, nil
}

// UpdateTracks changes existing tracks without SDP. A remote track changes its subscription's
// layer policy or pause; a layer change takes effect at the next keyframe of the new layer. A
// local track parks or resumes the participant's own publication for a mute: it keeps its MID
// and transceiver, forwards nothing while parked and resumes at the next keyframe. A track that
// is not live in this session is a per-track error.
func (s *Session) UpdateTracks(_ context.Context, request protocol.UpdateTracksRequest) (protocol.TracksResponse, error) {
	if err := validateTrackUpdates(request.Tracks); err != nil {
		return protocol.TracksResponse{}, err
	}
	s.opMu.Lock()
	defer s.opMu.Unlock()
	return once(s, request.OperationID, request, func() (protocol.TracksResponse, error) {
		response, updated, parked := s.matchUpdates(request.Tracks)
		for index, pub := range parked {
			if pub != nil {
				pub.setHeld(request.Tracks[index].Paused)
			}
		}
		for index, subscription := range updated {
			if subscription != nil {
				subscription.update(layerUpdateFor(request.Tracks[index], subscription))
			}
		}
		return response, nil
	})
}

func validateTrackUpdates(tracks []protocol.Track) error {
	if len(tracks) == 0 || len(tracks) > protocol.MaxTracksPerRequest {
		return fmt.Errorf("%w: a request updates 1 to %d tracks", ErrInvalidRequest, protocol.MaxTracksPerRequest)
	}
	for index, track := range tracks {
		if err := validateTrackUpdate(index, track); err != nil {
			return err
		}
	}
	return nil
}

func validateTrackUpdate(index int, track protocol.Track) error {
	switch {
	case track.Location == protocol.LocationLocal:
		if track.Mid == "" || track.TrackName == "" || track.Simulcast != nil {
			return fmt.Errorf("%w: tracks[%d] needs a mid and trackName and no simulcast policy for a local update", ErrInvalidRequest, index)
		}
	case track.Location != protocol.LocationRemote || track.Mid == "" || track.SessionID == "" || track.TrackName == "":
		return fmt.Errorf("%w: tracks[%d] needs a remote location, mid, sessionId and trackName", ErrInvalidRequest, index)
	case track.Simulcast != nil && track.Simulcast.PreferredRID == "":
		return fmt.Errorf("%w: tracks[%d] simulcast needs a preferredRid", ErrInvalidRequest, index)
	}
	return nil
}

// matchUpdates finds the publication or subscription each update names. It returns them by the
// update's index, with a per-track error for each one that is not live.
func (s *Session) matchUpdates(tracks []protocol.Track) (response protocol.TracksResponse, updated []*subscription, parked []*publication) {
	updated = make([]*subscription, len(tracks))
	parked = make([]*publication, len(tracks))
	s.mu.Lock()
	defer s.mu.Unlock()
	for index, track := range tracks {
		if track.Location == protocol.LocationLocal {
			pub := s.published[track.Mid]
			if pub == nil || pub.name != track.TrackName {
				response.TrackErrors = append(response.TrackErrors, protocol.TrackError{SessionID: s.id, TrackName: track.TrackName, Code: protocol.TrackCodeNotFound, Message: "no such publication"})
				continue
			}
			parked[index] = pub
			response.Tracks = append(response.Tracks, protocol.Track{Location: protocol.LocationLocal, Mid: track.Mid, TrackName: track.TrackName, Source: pub.source, Paused: track.Paused})
			continue
		}
		subscription := s.subscribed[track.Mid]
		if subscription == nil || subscription.pub.name != track.TrackName || subscription.pub.session.id != track.SessionID {
			response.TrackErrors = append(response.TrackErrors, protocol.TrackError{SessionID: track.SessionID, TrackName: track.TrackName, Code: protocol.TrackCodeNotFound, Message: "no such subscription"})
			continue
		}
		updated[index] = subscription
		response.Tracks = append(response.Tracks, protocol.Track{Location: protocol.LocationRemote, Mid: track.Mid, TrackName: track.TrackName, SessionID: track.SessionID, Simulcast: track.Simulcast, Paused: track.Paused})
	}
	return response, updated, parked
}

// layerUpdateFor is the layer request an update asks of the subscription. Without a simulcast
// policy the update only pauses or resumes.
func layerUpdateFor(track protocol.Track, subscription *subscription) layerRequest {
	if track.Simulcast != nil {
		return layerRequestFor(track)
	}
	next := subscription.currentRequest()
	next.paused = track.Paused
	return next
}

// closeMid stops one track and reports whether it existed. With receiveOnly it leaves
// publications alone, so a subscriber's close can never stop a camera.
func (s *Session) closeMid(mid string, receiveOnly bool) bool {
	s.mu.Lock()
	var pub *publication
	if !receiveOnly {
		pub = s.published[mid]
		delete(s.published, mid)
	}
	subscription := s.subscribed[mid]
	delete(s.subscribed, mid)
	if pub != nil {
		s.retired[mid] = true
	}
	s.mu.Unlock()
	switch {
	case pub != nil:
		pub.close()
	case subscription != nil:
		subscription.close()
	}
	return pub != nil || subscription != nil
}

// completeLocalDescription waits for the ICE candidates, so the SDP is complete.
func (s *Session) completeLocalDescription(ctx context.Context) (*protocol.SessionDescription, error) {
	gathered := webrtc.GatheringCompletePromise(s.pc)
	select {
	case <-gathered:
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(gatherTimeout):
		return nil, errors.New("ICE gathering timed out")
	}
	local := s.pc.LocalDescription()
	if local == nil {
		return nil, errors.New("no local description")
	}
	return &protocol.SessionDescription{SDP: local.SDP, Type: local.Type.String()}, nil
}

// failNegotiation closes the session: after a failed step its peer connection
// cannot return to a stable state, and the client replaces the connection.
func (s *Session) failNegotiation(step string, cause error) error {
	s.node.log.Warn("negotiation failed", "connection_id", s.id, "step", step, "error", cause)
	s.CloseFor(CloseNegotiationFailed)
	return fmt.Errorf("%w: %s: %w", ErrNegotiationFailed, step, cause)
}
