package chalksfu_test

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/apps/api/internal/adapters/pion"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// keyframeOnRequest publishes VP8 whose frames are delta frames until the node asks for a
// keyframe, as a real encoder does. Video behind a delta frame cannot be decoded, so the node
// holds it back from a subscriber until a keyframe arrives.
type keyframeOnRequest struct {
	requests atomic.Int64
}

func (k *keyframeOnRequest) run(ctx context.Context, track *webrtc.TrackLocalStaticRTP, sender *webrtc.RTPSender) {
	var wantKeyframe atomic.Bool
	go func() {
		for {
			packets, _, err := sender.ReadRTCP()
			if err != nil {
				return
			}
			for _, packet := range packets {
				switch packet.(type) {
				case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
					k.requests.Add(1)
					wantKeyframe.Store(true)
				}
			}
		}
	}()
	go func() {
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		var sequence uint16
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				sequence++
				payload := []byte{0x10, 0x01, 0, 0, 0, 0} // start of partition, delta frame
				if wantKeyframe.Swap(false) {
					payload = []byte{0x10, 0x00, 0, 0, 0, 0} // keyframe
				}
				_ = track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 96, SequenceNumber: sequence, Timestamp: uint32(sequence) * 3000, Marker: true}, Payload: payload})
			}
		}
	}()
}

// TestRecorderPeerReceivesVideoFromTheChalkSFU runs the recorder's real Pion peer against a real
// node through the CapturePlane adapter, for a camera that sends a keyframe only when asked.
func TestRecorderPeerReceivesVideoFromTheChalkSFU(t *testing.T) {
	box := startSFU(t, map[string]string{"SFU_PACKET_BUDGET": "200000"})
	episode := newCapturedEpisode(t, box, 7)
	ctx, stop := context.WithCancel(context.Background())
	t.Cleanup(stop)

	// The camera belongs to a second Participant: a session's first publisher peer carries the
	// microphone that newCapturedEpisode pushed.
	bob := mediaplane.Scope{TenantID: episode.alice.TenantID, EpisodeID: episode.alice.EpisodeID, ParticipantID: "bob", Generation: 1}
	box.grant(t, bob)
	bobConn, _ := join(t, episode.service, bob)
	publisher := newPeer(t)
	camera, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}, "bob-camera", "bob")
	if err != nil {
		t.Fatal(err)
	}
	sender, err := publisher.pc.AddTrack(camera)
	if err != nil {
		t.Fatal(err)
	}
	offer := publisher.offer(t)
	pushed, err := episode.service.AddTracks(ctx, mediaplane.TracksRequest{
		ConnectionID: bobConn, Scope: bob, SessionDescription: &offer,
		Tracks: []mediaplane.Track{{Location: "local", Mid: publisher.mid(t, camera), TrackName: "bob-camera", Source: "camera"}},
	})
	if err != nil || len(pushed.TrackErrors) != 0 {
		t.Fatalf("push camera: %+v, %v", pushed, err)
	}
	publisher.accept(t, pushed.SessionDescription)
	var encoder keyframeOnRequest
	encoder.run(ctx, camera, sender)

	video := episode.track
	video.OwnerReference, video.TrackReference = captureplane.ProviderReference(bobConn), "bob-camera"
	video.Source, video.Kind, video.RequestedLayer = captureplane.TrackSourceCamera, captureplane.TrackKindVideo, captureplane.TrackLayerAuto

	plane := box.adapter(t, box.ca, clientIdentity)
	created, err := plane.CreateCaptureConnection(ctx, captureplane.CreateCaptureConnectionInput{Metadata: episode.metadata(1, "create")})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	pulled, err := plane.PullCaptureTracks(ctx, captureplane.PullCaptureTracksInput{
		Metadata: episode.metadata(1, "pull"), Connection: created.Connection.ConnectionReference, Tracks: []captureplane.CaptureTrack{video},
	})
	if err != nil || len(pulled.Tracks) != 1 {
		t.Fatalf("pull = %+v, %v", pulled, err)
	}

	recorder, err := pion.NewPeer(pion.Config{CaptureEpoch: 1})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = recorder.Close() })
	if err := recorder.RegisterTracks(pulled.Tracks); err != nil {
		t.Fatalf("register: %v", err)
	}
	negotiated, err := recorder.Handle(ctx, pulled.Negotiation)
	if err != nil || negotiated.LocalDescription == nil {
		t.Fatalf("answer the node's offer: %+v, %v", negotiated, err)
	}
	if _, err := plane.RenegotiateCaptureConnection(ctx, captureplane.RenegotiateCaptureConnectionInput{
		Metadata: episode.metadata(1, "answer"), Connection: created.Connection.ConnectionReference,
		NegotiationID: pulled.Negotiation.ID, Description: *negotiated.LocalDescription,
	}); err != nil {
		t.Fatalf("renegotiate: %v", err)
	}

	waiting, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	track, err := recorder.WaitForTrack(waiting, pulled.Tracks[0].MID)
	if err != nil {
		t.Fatalf("the recorder never bound the video track: %v", err)
	}
	// The worker asks for a keyframe when a source binds, so retained RTP starts on one.
	if err := recorder.RequestKeyFrame(pulled.Tracks[0].MID); err != nil {
		t.Fatalf("request keyframe: %v", err)
	}
	var keyframe bool
	for packets := 0; packets < 200 && !keyframe; packets++ {
		_ = track.SetReadDeadline(time.Now().Add(10 * time.Second))
		packet, _, err := track.ReadRTP()
		if err != nil {
			t.Fatalf("read video after %d packets: %v", packets, err)
		}
		keyframe = len(packet.Payload) > 1 && packet.Payload[0]&0x10 != 0 && packet.Payload[1]&0x01 == 0
	}
	if !keyframe {
		t.Fatalf("no keyframe reached the recorder; the publisher saw %d keyframe requests", encoder.requests.Load())
	}
	if encoder.requests.Load() == 0 {
		t.Fatalf("a keyframe arrived without any keyframe request reaching the publisher")
	}
}
