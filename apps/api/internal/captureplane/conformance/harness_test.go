package conformance

import (
	"context"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestRunExercisesAllOperationsAndRetryIdempotency(t *testing.T) {
	Run(t, newFakePlane(), validFixture())
}

type fakePlane struct {
	connection captureplane.CaptureConnection
	tracks     []captureplane.PulledCaptureTrack
}

func newFakePlane() *fakePlane {
	return &fakePlane{
		connection: captureplane.CaptureConnection{
			ConnectionReference: captureplane.ProviderReference("connection-1"),
			CaptureEpoch:        1,
			PlanRevision:        1,
		},
	}
}

func (p *fakePlane) CreateCaptureConnection(context.Context, captureplane.CreateCaptureConnectionInput) (captureplane.CreateCaptureConnectionResult, error) {
	return captureplane.CreateCaptureConnectionResult{
		Connection: p.connection,
		Negotiation: captureplane.Negotiation{
			Requirement: captureplane.NegotiationNotRequired,
		},
	}, nil
}

func (p *fakePlane) PullCaptureTracks(_ context.Context, input captureplane.PullCaptureTracksInput) (captureplane.PullCaptureTracksResult, error) {
	if p.tracks == nil {
		for index, track := range input.Tracks {
			p.tracks = append(p.tracks, captureplane.PulledCaptureTrack{
				CaptureTrack: track,
				MID:          captureplane.ProviderReference("mid-" + string(rune('1'+index))),
			})
		}
	}
	return captureplane.PullCaptureTracksResult{
		Connection: p.connection,
		Tracks:     append([]captureplane.PulledCaptureTrack(nil), p.tracks...),
		Negotiation: captureplane.Negotiation{
			ID:          captureplane.ProviderReference("negotiation-1"),
			Requirement: captureplane.NegotiationAnswerNeeded,
			Description: &captureplane.Description{Type: "offer", SDP: "v=0"},
		},
	}, nil
}

func (p *fakePlane) RenegotiateCaptureConnection(context.Context, captureplane.RenegotiateCaptureConnectionInput) (captureplane.RenegotiateCaptureConnectionResult, error) {
	return captureplane.RenegotiateCaptureConnectionResult{
		Connection:  p.connection,
		Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired},
	}, nil
}

func (p *fakePlane) InspectCaptureConnection(context.Context, captureplane.InspectCaptureConnectionInput) (captureplane.InspectCaptureConnectionResult, error) {
	observed := make([]captureplane.ObservedCaptureTrack, 0, len(p.tracks))
	for _, track := range p.tracks {
		observed = append(observed, captureplane.ObservedCaptureTrack{PulledCaptureTrack: track, Active: true})
	}
	return captureplane.InspectCaptureConnectionResult{
		Connection:  p.connection,
		State:       captureplane.CaptureConnectionConnected,
		Tracks:      observed,
		Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired},
	}, nil
}

func (p *fakePlane) CloseCaptureTracks(context.Context, captureplane.CloseCaptureTracksInput) (captureplane.CloseCaptureTracksResult, error) {
	return captureplane.CloseCaptureTracksResult{
		Connection:  p.connection,
		Tracks:      append([]captureplane.PulledCaptureTrack(nil), p.tracks...),
		Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired},
	}, nil
}

func (p *fakePlane) CloseCaptureConnection(context.Context, captureplane.CloseCaptureConnectionInput) (captureplane.CloseCaptureConnectionResult, error) {
	return captureplane.CloseCaptureConnectionResult{Connection: p.connection, Closed: true}, nil
}

func validFixture() Fixture {
	return Fixture{
		Metadata: captureplane.OperationMetadata{
			Identity: captureplane.CaptureIdentity{
				TenantID:    utilities.IDFromBytes([16]byte{1}),
				SpaceID:     utilities.IDFromBytes([16]byte{2}),
				EpisodeID:   utilities.IDFromBytes([16]byte{3}),
				RecordingID: utilities.IDFromBytes([16]byte{4}),
			},
			CaptureEpoch: 1, PlanRevision: 1, IdempotencyKey: "conformance-1",
		},
		Tracks: []captureplane.CaptureTrack{
			{
				OwnerReference:        captureplane.ProviderReference("owner-1"),
				TrackReference:        captureplane.ProviderReference("track-microphone-1"),
				ParticipantID:         utilities.IDFromBytes([16]byte{5}),
				ParticipantGeneration: 1,
				Source:                captureplane.TrackSourceMicrophone,
				Kind:                  captureplane.TrackKindAudio,
				RequestedLayer:        captureplane.TrackLayerAuto,
			},
			{
				OwnerReference:        captureplane.ProviderReference("owner-1"),
				TrackReference:        captureplane.ProviderReference("track-camera-1"),
				ParticipantID:         utilities.IDFromBytes([16]byte{5}),
				ParticipantGeneration: 1,
				Source:                captureplane.TrackSourceCamera,
				Kind:                  captureplane.TrackKindVideo,
				RequestedLayer:        captureplane.TrackLayerHigh,
			},
		},
		RenegotiationDescription: captureplane.Description{Type: "answer", SDP: "v=0"},
	}
}
