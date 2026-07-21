package mediaplane

import (
	"context"
	"errors"
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

func TestCloseTracksValidatesAndDelegates(t *testing.T) {
	plane := &signalingPlaneStub{
		closeResponse: CloseTracksResponse{
			Tracks: []CloseTrack{
				{Mid: "0", Source: "microphone", PublicationID: "publication_0"},
				{Mid: "1", Source: "camera", PublicationID: "publication_1"},
			},
			RequiresImmediateRenegotiation: true,
		},
	}
	service := NewServiceForProvider(ProviderCloudflareSFU, plane)
	wantSDP := "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"

	response, err := service.CloseTracks(context.Background(), CloseTracksRequest{
		Provider:           ProviderCloudflareSFU,
		ConnectionID:       " connection_123 ",
		SessionDescription: &SessionDescription{Type: "offer", SDP: wantSDP},
		Tracks: []CloseTrack{
			{Mid: " 0 ", Source: " microphone ", PublicationID: " publication_0 "},
			{Mid: "1", Source: "camera", PublicationID: "publication_1"},
		},
	})
	if err != nil {
		t.Fatalf("close tracks: %v", err)
	}
	if plane.closeRequest.ConnectionID != "connection_123" {
		t.Fatalf("connection id = %q, want trimmed value", plane.closeRequest.ConnectionID)
	}
	if plane.closeRequest.Tracks[0] != (CloseTrack{Mid: "0", Source: "microphone", PublicationID: "publication_0"}) {
		t.Fatalf("track = %#v, want trimmed identity", plane.closeRequest.Tracks[0])
	}
	if plane.closeRequest.SessionDescription == nil || plane.closeRequest.SessionDescription.SDP != wantSDP {
		t.Fatalf("SDP = %#v, want exact terminated SDP", plane.closeRequest.SessionDescription)
	}
	if !response.RequiresImmediateRenegotiation {
		t.Fatal("requires immediate renegotiation = false, want true")
	}
}

func TestCloseTracksRejectsInvalidRequests(t *testing.T) {
	service := NewServiceForProvider(ProviderCloudflareSFU, &signalingPlaneStub{})
	tests := []struct {
		name  string
		input CloseTracksRequest
		want  error
	}{
		{
			name:  "provider mismatch",
			input: CloseTracksRequest{Provider: ProviderCloudflareRTK, ConnectionID: "connection_123", Tracks: []CloseTrack{{Mid: "0", Source: "microphone", PublicationID: "publication_0"}}},
			want:  ErrInvalidProvider,
		},
		{
			name:  "blank connection",
			input: CloseTracksRequest{Provider: ProviderCloudflareSFU, Tracks: []CloseTrack{{Mid: "0", Source: "microphone", PublicationID: "publication_0"}}},
			want:  ErrInvalidSignalRequest,
		},
		{
			name:  "no mids",
			input: CloseTracksRequest{Provider: ProviderCloudflareSFU, ConnectionID: "connection_123"},
			want:  ErrInvalidSignalRequest,
		},
		{
			name:  "blank mid",
			input: CloseTracksRequest{Provider: ProviderCloudflareSFU, ConnectionID: "connection_123", Tracks: []CloseTrack{{Mid: " ", Source: "microphone", PublicationID: "publication_0"}}},
			want:  ErrInvalidSignalRequest,
		},
		{
			name: "duplicate mid",
			input: CloseTracksRequest{Provider: ProviderCloudflareSFU, ConnectionID: "connection_123", Tracks: []CloseTrack{
				{Mid: "0", Source: "microphone", PublicationID: "publication_0"},
				{Mid: " 0 ", Source: "camera", PublicationID: "publication_1"},
			}},
			want: ErrInvalidSignalRequest,
		},
		{
			name:  "invalid source",
			input: CloseTracksRequest{Provider: ProviderCloudflareSFU, ConnectionID: "connection_123", Tracks: []CloseTrack{{Mid: "0", Source: "other", PublicationID: "publication_0"}}},
			want:  ErrInvalidSignalRequest,
		},
		{
			name:  "missing publication id",
			input: CloseTracksRequest{Provider: ProviderCloudflareSFU, ConnectionID: "connection_123", Tracks: []CloseTrack{{Mid: "0", Source: "microphone"}}},
			want:  ErrInvalidSignalRequest,
		},
		{
			name: "invalid description",
			input: CloseTracksRequest{
				Provider:           ProviderCloudflareSFU,
				ConnectionID:       "connection_123",
				Tracks:             []CloseTrack{{Mid: "0", Source: "microphone", PublicationID: "publication_0"}},
				SessionDescription: &SessionDescription{Type: "offer"},
			},
			want: ErrInvalidSignalRequest,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := service.CloseTracks(context.Background(), tt.input)
			if !errors.Is(err, tt.want) {
				t.Fatalf("error = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestCloseTracksReturnsUnsupportedForNonSignalingPlane(t *testing.T) {
	service := NewServiceForProvider(ProviderCloudflareRTK, &planeStub{})

	_, err := service.CloseTracks(context.Background(), CloseTracksRequest{
		Provider:     ProviderCloudflareRTK,
		ConnectionID: "connection_123",
		Tracks:       []CloseTrack{{Mid: "0", Source: "microphone", PublicationID: "publication_0"}},
	})
	if !errors.Is(err, ErrUnsupportedOperation) {
		t.Fatalf("error = %v, want %v", err, ErrUnsupportedOperation)
	}
}

type signalingPlaneStub struct {
	tracksRequest TracksRequest
	closeRequest  CloseTracksRequest
	closeResponse CloseTracksResponse
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

func (s *signalingPlaneStub) CloseTracks(_ context.Context, input CloseTracksRequest) (CloseTracksResponse, error) {
	s.closeRequest = input
	return s.closeResponse, nil
}

func (s *signalingPlaneStub) Renegotiate(context.Context, RenegotiateRequest) error {
	return nil
}
