package chalksfu_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/captureplane/conformance"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// capturedEpisode is a live Episode on a real node with one Participant publishing a microphone,
// and the metadata a recorder of that Episode sends.
type capturedEpisode struct {
	service   mediaplane.Service
	identity  captureplane.CaptureIdentity
	alice     mediaplane.Scope
	aliceConn string
	track     captureplane.CaptureTrack
}

func newCapturedEpisode(t *testing.T, box *sfu, seed byte) capturedEpisode {
	t.Helper()
	identity := captureplane.CaptureIdentity{
		TenantID:    utilities.IDFromBytes([16]byte{1, seed}),
		SpaceID:     utilities.IDFromBytes([16]byte{2, seed}),
		EpisodeID:   utilities.IDFromBytes([16]byte{3, seed}),
		RecordingID: utilities.IDFromBytes([16]byte{4, seed}),
	}
	alice := mediaplane.Scope{TenantID: identity.TenantID.String(), EpisodeID: identity.EpisodeID.String(), ParticipantID: "alice", Generation: 1}
	box.grant(t, alice)
	service := box.service(t)
	aliceConn, _ := join(t, service, alice)
	publish(t, service, aliceConn, alice, "alice-mic", "microphone")
	return capturedEpisode{
		service: service, identity: identity, alice: alice, aliceConn: aliceConn,
		track: captureplane.CaptureTrack{
			OwnerReference: captureplane.ProviderReference(aliceConn), TrackReference: "alice-mic",
			ParticipantID: utilities.IDFromBytes([16]byte{5, seed}), ParticipantGeneration: 1,
			Source: captureplane.TrackSourceMicrophone, Kind: captureplane.TrackKindAudio, RequestedLayer: captureplane.TrackLayerAuto,
		},
	}
}

func (e capturedEpisode) metadata(epoch captureplane.CaptureEpoch, key string) captureplane.OperationMetadata {
	return captureplane.OperationMetadata{Identity: e.identity, CaptureEpoch: epoch, PlanRevision: 1, IdempotencyKey: key}
}

// answeringPlane stands in for the recorder's peer. The conformance fixture fixes the answer
// before the node's offer exists, so this answers each offer with a real peer and sends that.
type answeringPlane struct {
	captureplane.CapturePlane
	t        *testing.T
	recorder *peer

	mu      sync.Mutex
	answers map[captureplane.ProviderReference]captureplane.Description
}

func (p *answeringPlane) PullCaptureTracks(ctx context.Context, input captureplane.PullCaptureTracksInput) (captureplane.PullCaptureTracksResult, error) {
	result, err := p.CapturePlane.PullCaptureTracks(ctx, input)
	if err != nil || result.Negotiation.Requirement != captureplane.NegotiationAnswerNeeded {
		return result, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, answered := p.answers[result.Negotiation.ID]; !answered {
		offer := mediaplane.SessionDescription{Type: result.Negotiation.Description.Type, SDP: result.Negotiation.Description.SDP}
		answer := p.recorder.answer(p.t, &offer)
		p.answers[result.Negotiation.ID] = captureplane.Description{Type: answer.Type, SDP: answer.SDP}
	}
	return result, nil
}

func (p *answeringPlane) RenegotiateCaptureConnection(ctx context.Context, input captureplane.RenegotiateCaptureConnectionInput) (captureplane.RenegotiateCaptureConnectionResult, error) {
	p.mu.Lock()
	if answer, ok := p.answers[input.NegotiationID]; ok {
		input.Description = answer
	}
	p.mu.Unlock()
	return p.CapturePlane.RenegotiateCaptureConnection(ctx, input)
}

func newAnsweringPlane(t *testing.T, box *sfu) *answeringPlane {
	t.Helper()
	return &answeringPlane{CapturePlane: box.adapter(t, box.ca, clientIdentity), t: t, recorder: newPeer(t), answers: map[captureplane.ProviderReference]captureplane.Description{}}
}

func TestCapturePlaneConformsToProviderNeutralPort(t *testing.T) {
	box := startSFU(t, map[string]string{"SFU_PACKET_BUDGET": "200000"})
	episode := newCapturedEpisode(t, box, 1)
	conformance.Run(t, newAnsweringPlane(t, box), conformance.Fixture{
		Metadata:                 episode.metadata(1, "conformance-1"),
		Tracks:                   []captureplane.CaptureTrack{episode.track},
		RenegotiationDescription: captureplane.Description{Type: "answer", SDP: "v=0\r\n"},
	})
}

func TestCapturePlaneDeliversTheEpisodesMediaToTheRecorder(t *testing.T) {
	box := startSFU(t, map[string]string{"SFU_PACKET_BUDGET": "200000"})
	episode := newCapturedEpisode(t, box, 2)
	plane := newAnsweringPlane(t, box)
	ctx := context.Background()

	created, err := plane.CreateCaptureConnection(ctx, captureplane.CreateCaptureConnectionInput{Metadata: episode.metadata(1, "create")})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	pulled, err := plane.PullCaptureTracks(ctx, captureplane.PullCaptureTracksInput{
		Metadata: episode.metadata(1, "pull"), Connection: created.Connection.ConnectionReference, Tracks: []captureplane.CaptureTrack{episode.track},
	})
	if err != nil || len(pulled.Tracks) != 1 || pulled.Negotiation.Requirement != captureplane.NegotiationAnswerNeeded {
		t.Fatalf("pull = %+v, %v", pulled, err)
	}
	if _, err := plane.RenegotiateCaptureConnection(ctx, captureplane.RenegotiateCaptureConnectionInput{
		Metadata: episode.metadata(1, "answer"), Connection: created.Connection.ConnectionReference,
		NegotiationID: pulled.Negotiation.ID, Description: captureplane.Description{Type: "answer", SDP: "v=0\r\n"},
	}); err != nil {
		t.Fatalf("answer: %v", err)
	}
	eventually(t, "media to reach the recorder", 20*time.Second, func() bool { return plane.recorder.received.Load() >= 20 })
	eventually(t, "the track to report active", 10*time.Second, func() bool {
		inspected, err := plane.InspectCaptureConnection(ctx, captureplane.InspectCaptureConnectionInput{
			Metadata: episode.metadata(1, "inspect-"+time.Now().String()), Connection: created.Connection.ConnectionReference, Tracks: pulled.Tracks,
		})
		return err == nil && inspected.State == captureplane.CaptureConnectionConnected && len(inspected.Tracks) == 1 && inspected.Tracks[0].Active
	})
}

func TestCapturePlaneReportsAnUnpublishedTrackAsUnavailable(t *testing.T) {
	box := startSFU(t, map[string]string{"SFU_PACKET_BUDGET": "200000"})
	episode := newCapturedEpisode(t, box, 3)
	plane := newAnsweringPlane(t, box)
	ctx := context.Background()
	created, err := plane.CreateCaptureConnection(ctx, captureplane.CreateCaptureConnectionInput{Metadata: episode.metadata(1, "create")})
	if err != nil {
		t.Fatal(err)
	}
	missing := episode.track
	missing.TrackReference = "alice-camera"
	missing.Source, missing.Kind, missing.RequestedLayer = captureplane.TrackSourceCamera, captureplane.TrackKindVideo, captureplane.TrackLayerHigh
	pulled, err := plane.PullCaptureTracks(ctx, captureplane.PullCaptureTracksInput{
		Metadata: episode.metadata(1, "pull"), Connection: created.Connection.ConnectionReference, Tracks: []captureplane.CaptureTrack{episode.track, missing},
	})
	if err != nil {
		t.Fatalf("pull: %v", err)
	}
	if len(pulled.Tracks) != 1 || pulled.Tracks[0].TrackReference != "alice-mic" || len(pulled.Unavailable) != 1 || pulled.Unavailable[0].TrackReference != "alice-camera" {
		t.Fatalf("pull = %+v", pulled)
	}
}

func TestCapturePlaneFencesAnOlderEpoch(t *testing.T) {
	box := startSFU(t, map[string]string{"SFU_PACKET_BUDGET": "200000"})
	episode := newCapturedEpisode(t, box, 4)
	plane := newAnsweringPlane(t, box)
	ctx := context.Background()
	old, err := plane.CreateCaptureConnection(ctx, captureplane.CreateCaptureConnectionInput{Metadata: episode.metadata(1, "create-1")})
	if err != nil {
		t.Fatal(err)
	}
	current, err := plane.CreateCaptureConnection(ctx, captureplane.CreateCaptureConnectionInput{Metadata: episode.metadata(2, "create-2")})
	if err != nil {
		t.Fatalf("epoch 2: %v", err)
	}
	tracks := []captureplane.CaptureTrack{episode.track}

	t.Run("the replaced connection of epoch 1 is gone", func(t *testing.T) {
		_, err := plane.PullCaptureTracks(ctx, captureplane.PullCaptureTracksInput{Metadata: episode.metadata(1, "pull-old"), Connection: old.Connection.ConnectionReference, Tracks: tracks})
		var failure captureplane.ProviderError
		if !errors.As(err, &failure) || failure.Class != captureplane.ProviderFailureNotFound {
			t.Fatalf("pull on the replaced connection: %v, want a not-found failure", err)
		}
	})
	t.Run("epoch 1 cannot create again once epoch 2 exists", func(t *testing.T) {
		_, err := plane.CreateCaptureConnection(ctx, captureplane.CreateCaptureConnectionInput{Metadata: episode.metadata(1, "create-stale")})
		var fenced *captureplane.FencedError
		if !errors.As(err, &fenced) || fenced.Reason != captureplane.FencedByCaptureEpoch {
			t.Fatalf("create with a stale epoch: %v, want a capture epoch fence", err)
		}
	})
	t.Run("epoch 1 cannot act on the connection of epoch 2", func(t *testing.T) {
		_, err := plane.PullCaptureTracks(ctx, captureplane.PullCaptureTracksInput{Metadata: episode.metadata(1, "pull-stale"), Connection: current.Connection.ConnectionReference, Tracks: tracks})
		var failure captureplane.ProviderError
		if !errors.As(err, &failure) || failure.Class != captureplane.ProviderFailureNotFound {
			t.Fatalf("pull with a stale epoch: %v, want a not-found failure (the node reads another generation as gone)", err)
		}
	})
}

func TestCapturePlaneClosesTwiceAndRemovesTheSession(t *testing.T) {
	box := startSFU(t, map[string]string{"SFU_PACKET_BUDGET": "200000"})
	episode := newCapturedEpisode(t, box, 5)
	plane := newAnsweringPlane(t, box)
	ctx := context.Background()
	created, err := plane.CreateCaptureConnection(ctx, captureplane.CreateCaptureConnectionInput{Metadata: episode.metadata(1, "create")})
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"close-1", "close-2"} {
		closed, err := plane.CloseCaptureConnection(ctx, captureplane.CloseCaptureConnectionInput{Metadata: episode.metadata(1, key), Connection: created.Connection.ConnectionReference, Force: true})
		if err != nil || !closed.Closed {
			t.Fatalf("close %s = %+v, %v", key, closed, err)
		}
	}
	_, err = plane.InspectCaptureConnection(ctx, captureplane.InspectCaptureConnectionInput{Metadata: episode.metadata(1, "inspect"), Connection: created.Connection.ConnectionReference})
	var failure captureplane.ProviderError
	if !errors.As(err, &failure) || failure.Class != captureplane.ProviderFailureNotFound {
		t.Fatalf("inspect after close: %v, want a not-found failure", err)
	}
}

func TestCapturePlaneRefusesWhenTheNodeTakesNoCaptures(t *testing.T) {
	box := startSFU(t, map[string]string{"SFU_PACKET_BUDGET": "200000", "SFU_MAX_CAPTURES_PER_EPISODE": "0"})
	episode := newCapturedEpisode(t, box, 6)
	_, err := newAnsweringPlane(t, box).CreateCaptureConnection(context.Background(), captureplane.CreateCaptureConnectionInput{Metadata: episode.metadata(1, "create")})
	var failure captureplane.ProviderError
	if !errors.As(err, &failure) || failure.Class != captureplane.ProviderFailureProtocol || failure.Retryable {
		t.Fatalf("create on a node without captures: %v", err)
	}
}
