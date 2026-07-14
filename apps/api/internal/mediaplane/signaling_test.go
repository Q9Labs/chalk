package mediaplane

import (
	"context"
	"testing"
)

func TestAddTracksPreservesSDPTermination(t *testing.T) {
	plane := &signalingPlaneStub{}
	service := NewServiceForProvider(ProviderCloudflareSFU, plane)
	wantSDP := "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"

	_, err := service.AddTracks(context.Background(), TracksRequest{
		ConnectionID:       "connection_123",
		SessionDescription: &SessionDescription{Type: "offer", SDP: wantSDP},
		Tracks:             []Track{{Location: "local", Mid: "0", TrackName: "microphone_123", Source: "microphone"}},
	})
	if err != nil {
		t.Fatalf("add tracks: %v", err)
	}
	if plane.tracksRequest.SessionDescription == nil {
		t.Fatal("SDP = nil, want terminated SDP")
	}
	if plane.tracksRequest.SessionDescription.SDP != wantSDP {
		t.Fatalf("SDP = %q, want exact terminated SDP %q", plane.tracksRequest.SessionDescription.SDP, wantSDP)
	}
}

type signalingPlaneStub struct {
	tracksRequest TracksRequest
}

func (s *signalingPlaneStub) EnsureSession(context.Context, EnsureSessionInput) (Session, error) {
	return Session{}, nil
}

func (s *signalingPlaneStub) CreateJoin(context.Context, CreateJoinInput) (Join, error) {
	return Join{}, nil
}

func (s *signalingPlaneStub) RemoveParticipant(context.Context, RemoveParticipantInput) error {
	return nil
}

func (s *signalingPlaneStub) EndSession(context.Context, EndSessionInput) error {
	return nil
}

func (s *signalingPlaneStub) SessionUsage(context.Context, SessionUsageInput) (Usage, error) {
	return Usage{}, nil
}

func (s *signalingPlaneStub) AddTracks(_ context.Context, input TracksRequest) (TracksResponse, error) {
	s.tracksRequest = input
	return TracksResponse{}, nil
}

func (s *signalingPlaneStub) Renegotiate(context.Context, RenegotiateRequest) error {
	return nil
}
