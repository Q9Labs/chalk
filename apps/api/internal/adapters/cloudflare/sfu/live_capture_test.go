package sfu_test

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	cloudflaresfu "github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu"
	chalkpion "github.com/q9labs/chalk/apps/api/internal/adapters/pion"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const liveCaptureFlag = "CHALK_RUN_LIVE_SFU_CAPTURE_TEST"

// TestLiveCloudflareSFUCaptureReceivesRTP is an explicit, bounded provider
// qualification. It creates exactly one A/V publisher and one recorder,
// verifies forwarded RTP rather than an empty connection, and detaches tracks
// without invoking a provider connection-delete operation.
func TestLiveCloudflareSFUCaptureReceivesRTP(t *testing.T) {
	if os.Getenv(liveCaptureFlag) != "1" {
		t.Skip(liveCaptureFlag + " is not enabled")
	}
	appID := strings.TrimSpace(os.Getenv(config.CloudflareRealtimeAppID))
	appSecret := strings.TrimSpace(os.Getenv(config.CloudflareRealtimeAppSecret))
	if appID == "" || appSecret == "" {
		t.Fatalf("%s and %s are required", config.CloudflareRealtimeAppID, config.CloudflareRealtimeAppSecret)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 75*time.Second)
	defer cancel()
	adapter, err := cloudflaresfu.NewAdapter(config.CloudflareRealtimeConfig{
		RealtimeAppID: appID, RealtimeAppSecret: appSecret, RequestTimeout: 10 * time.Second,
	})
	if err != nil {
		t.Fatalf("create live SFU adapter: %v", err)
	}
	identity := captureplane.CaptureIdentity{
		TenantID: liveCaptureID(t), SpaceID: liveCaptureID(t), EpisodeID: liveCaptureID(t), RecordingID: liveCaptureID(t),
	}

	var (
		publisher              *webrtc.PeerConnection
		recorder               *chalkpion.Peer
		publisherConnection    string
		publisherTracks        []mediaplane.CloseTrack
		recorderConnection     captureplane.ProviderReference
		pulledTracks           []captureplane.PulledCaptureTrack
		stopMedia              context.CancelFunc
		cleanupOnce            sync.Once
		cleanupOperationSuffix = fmt.Sprintf("%d", time.Now().UTC().UnixNano())
	)
	cleanup := func() {
		cleanupOnce.Do(func() {
			if stopMedia != nil {
				stopMedia()
			}
			if !recorderConnection.IsZero() {
				cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
				_, closeErr := adapter.CloseCaptureConnection(cleanupCtx, captureplane.CloseCaptureConnectionInput{
					Metadata:   liveCaptureMetadata(identity, "close-recorder-"+cleanupOperationSuffix),
					Connection: recorderConnection, Tracks: pulledTracks, Force: true,
				})
				cleanupCancel()
				if closeErr != nil {
					t.Errorf("close live recorder tracks: %v", closeErr)
				}
			}
			if publisherConnection != "" && len(publisherTracks) > 0 {
				cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
				_, closeErr := adapter.CloseTracks(cleanupCtx, mediaplane.CloseTracksRequest{
					Provider: mediaplane.ProviderCloudflareSFU, ConnectionID: publisherConnection,
					Tracks: publisherTracks, Force: true,
				})
				cleanupCancel()
				if closeErr != nil {
					t.Errorf("close live publisher tracks: %v", closeErr)
				}
			}
			if recorder != nil {
				if closeErr := recorder.Close(); closeErr != nil {
					t.Errorf("close local recorder peer: %v", closeErr)
				}
			}
			if publisher != nil {
				if closeErr := publisher.Close(); closeErr != nil {
					t.Errorf("close local publisher peer: %v", closeErr)
				}
			}
		})
	}
	t.Cleanup(cleanup)

	iceConfiguration := webrtc.Configuration{ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:stun.cloudflare.com:3478"}}}}
	publisher, err = webrtc.NewPeerConnection(iceConfiguration)
	if err != nil {
		t.Fatalf("create publisher peer: %v", err)
	}
	audioName := "chalk-live-audio-" + cleanupOperationSuffix
	videoName := "chalk-live-video-" + cleanupOperationSuffix
	audioTrack, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeOpus, ClockRate: 48_000, Channels: 2,
	}, audioName, "chalk-live-publisher")
	if err != nil {
		t.Fatalf("create publisher audio track: %v", err)
	}
	videoTrack, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000,
	}, videoName, "chalk-live-publisher")
	if err != nil {
		t.Fatalf("create publisher video track: %v", err)
	}
	audioSender, err := publisher.AddTrack(audioTrack)
	if err != nil {
		t.Fatalf("add publisher audio track: %v", err)
	}
	videoSender, err := publisher.AddTrack(videoTrack)
	if err != nil {
		t.Fatalf("add publisher video track: %v", err)
	}

	offer, err := publisher.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create publisher offer: %v", err)
	}
	gathered := webrtc.GatheringCompletePromise(publisher)
	if err := publisher.SetLocalDescription(offer); err != nil {
		t.Fatalf("set publisher local offer: %v", err)
	}
	select {
	case <-gathered:
	case <-ctx.Done():
		t.Fatalf("gather publisher ICE: %v", ctx.Err())
	}
	audioMID := liveSenderMID(t, publisher, audioSender)
	videoMID := liveSenderMID(t, publisher, videoSender)

	episode := mediaplane.Episode{Provider: mediaplane.ProviderCloudflareSFU, Ref: "live-capture-" + cleanupOperationSuffix}
	join, err := adapter.CreateJoin(ctx, mediaplane.CreateJoinInput{
		Provider: mediaplane.ProviderCloudflareSFU, Episode: episode,
		ParticipantName: "live-capture-publisher", ExternalParticipantID: "live-capture-publisher",
		ParticipantPreset: "live-capture",
	})
	if err != nil {
		t.Fatalf("create publisher connection: %v", err)
	}
	publisherConnection, _ = join.ClientPayload["connectionId"].(string)
	if strings.TrimSpace(publisherConnection) == "" {
		t.Fatal("publisher connection reference is missing")
	}
	localDescription := publisher.LocalDescription()
	if localDescription == nil {
		t.Fatal("publisher local description is missing")
	}
	publisherTracks = []mediaplane.CloseTrack{
		{Mid: audioMID, Source: "microphone", PublicationID: audioName},
		{Mid: videoMID, Source: "camera", PublicationID: videoName},
	}
	publishResult, err := adapter.AddTracks(ctx, mediaplane.TracksRequest{
		ConnectionID: publisherConnection,
		SessionDescription: &mediaplane.SessionDescription{
			Type: localDescription.Type.String(), SDP: localDescription.SDP,
		},
		Tracks: []mediaplane.Track{
			{Location: "local", Mid: audioMID, TrackName: audioName, Source: "microphone"},
			{Location: "local", Mid: videoMID, TrackName: videoName, Source: "camera"},
		},
	})
	if err != nil {
		t.Fatalf("publish live tracks: %v", err)
	}
	if publishResult.SessionDescription == nil || publishResult.SessionDescription.Type != "answer" || strings.TrimSpace(publishResult.SessionDescription.SDP) == "" {
		t.Fatalf("publisher answer is missing or invalid: requirement=%t", publishResult.RequiresImmediateRenegotiation)
	}
	if err := publisher.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeAnswer, SDP: publishResult.SessionDescription.SDP,
	}); err != nil {
		t.Fatalf("apply publisher answer: %v", err)
	}

	mediaCtx, mediaCancel := context.WithCancel(ctx)
	stopMedia = mediaCancel
	mediaErrors := make(chan error, 1)
	go writeLiveCaptureMedia(mediaCtx, audioTrack, videoTrack, mediaErrors)

	created, err := adapter.CreateCaptureConnection(ctx, captureplane.CreateCaptureConnectionInput{
		Metadata: liveCaptureMetadata(identity, "create-recorder-"+cleanupOperationSuffix),
	})
	if err != nil {
		t.Fatalf("create recorder connection: %v", err)
	}
	recorderConnection = created.Connection.ConnectionReference
	if created.Negotiation.Requirement != captureplane.NegotiationNotRequired {
		t.Fatalf("initial recorder negotiation = %q, want not_required", created.Negotiation.Requirement)
	}
	recorder, err = chalkpion.NewPeer(chalkpion.Config{CaptureEpoch: 1, Configuration: iceConfiguration})
	if err != nil {
		t.Fatalf("create local recorder peer: %v", err)
	}
	participantID := liveCaptureID(t)
	requestedTracks := []captureplane.CaptureTrack{
		{
			OwnerReference: recorderProviderReference(t, publisherConnection), TrackReference: recorderProviderReference(t, audioName),
			ParticipantID: participantID, ParticipantGeneration: 1, Source: captureplane.TrackSourceMicrophone,
			Kind: captureplane.TrackKindAudio, RequestedLayer: captureplane.TrackLayerAuto,
		},
		{
			OwnerReference: recorderProviderReference(t, publisherConnection), TrackReference: recorderProviderReference(t, videoName),
			ParticipantID: participantID, ParticipantGeneration: 1, Source: captureplane.TrackSourceCamera,
			Kind: captureplane.TrackKindVideo, RequestedLayer: captureplane.TrackLayerAuto,
		},
	}
	pulled, err := adapter.PullCaptureTracks(ctx, captureplane.PullCaptureTracksInput{
		Metadata:   liveCaptureMetadata(identity, "pull-tracks-"+cleanupOperationSuffix),
		Connection: recorderConnection, Tracks: requestedTracks,
	})
	if err != nil {
		t.Fatalf("pull live capture tracks: %v", err)
	}
	pulledTracks = pulled.Tracks
	if len(pulledTracks) != 2 {
		t.Fatalf("pulled track count = %d, want 2", len(pulledTracks))
	}
	if err := recorder.RegisterTracks(pulledTracks); err != nil {
		t.Fatalf("register live capture tracks: %v", err)
	}
	if err := settleLiveCaptureNegotiation(ctx, adapter, recorder, identity, recorderConnection, pulled.Negotiation, cleanupOperationSuffix); err != nil {
		t.Fatalf("settle live capture negotiation: %v", err)
	}

	type receivedTrack struct {
		codec   string
		packets int
		bytes   int
		err     error
	}
	received := make(chan receivedTrack, len(pulledTracks))
	for _, pulledTrack := range pulledTracks {
		pulledTrack := pulledTrack
		go func() {
			track, waitErr := recorder.WaitForTrack(ctx, pulledTrack.MID)
			if waitErr != nil {
				received <- receivedTrack{err: waitErr}
				return
			}
			result := receivedTrack{codec: track.Codec()}
			for result.packets < 3 {
				if deadlineErr := track.SetReadDeadline(time.Now().Add(10 * time.Second)); deadlineErr != nil {
					result.err = deadlineErr
					break
				}
				packet, _, readErr := track.ReadRTP()
				if readErr != nil {
					result.err = readErr
					break
				}
				result.packets++
				result.bytes += len(packet.Payload)
			}
			received <- result
		}()
	}
	var (
		packetCount int
		byteCount   int
		codecs      []string
	)
	for range pulledTracks {
		select {
		case result := <-received:
			if result.err != nil {
				t.Fatalf("receive live RTP: %v", result.err)
			}
			if result.packets < 3 || result.bytes <= 0 {
				t.Fatalf("received RTP packets=%d bytes=%d", result.packets, result.bytes)
			}
			packetCount += result.packets
			byteCount += result.bytes
			codecs = append(codecs, result.codec)
		case mediaErr := <-mediaErrors:
			t.Fatalf("send live RTP: %v", mediaErr)
		case <-ctx.Done():
			t.Fatalf("receive live RTP: %v", ctx.Err())
		}
	}
	sort.Strings(codecs)
	if len(codecs) != 2 || codecs[0] != "opus" || codecs[1] != "vp8" {
		t.Fatalf("received codecs = %v, want [opus vp8]", codecs)
	}
	t.Logf("live_capture_result publishers=1 recorders=1 tracks=2 packets=%d bytes=%d codecs=%s", packetCount, byteCount, strings.Join(codecs, ","))
}

func liveSenderMID(t *testing.T, peer *webrtc.PeerConnection, sender *webrtc.RTPSender) string {
	t.Helper()
	for _, transceiver := range peer.GetTransceivers() {
		if transceiver.Sender() == sender && strings.TrimSpace(transceiver.Mid()) != "" {
			return transceiver.Mid()
		}
	}
	t.Fatal("publisher sender MID is missing")
	return ""
}

func liveCaptureMetadata(identity captureplane.CaptureIdentity, idempotencyKey string) captureplane.OperationMetadata {
	return captureplane.OperationMetadata{
		Identity:     identity,
		CaptureEpoch: 1, PlanRevision: 1, IdempotencyKey: idempotencyKey,
	}
}

func liveCaptureID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatalf("generate live capture ID: %v", err)
	}
	return id
}

func recorderProviderReference(t *testing.T, value string) captureplane.ProviderReference {
	t.Helper()
	reference, err := captureplane.NewProviderReference(value)
	if err != nil {
		t.Fatalf("validate provider reference: %v", err)
	}
	return reference
}

func settleLiveCaptureNegotiation(ctx context.Context, adapter cloudflaresfu.Adapter, recorder *chalkpion.Peer, identity captureplane.CaptureIdentity, connection captureplane.ProviderReference, negotiation captureplane.Negotiation, suffix string) error {
	for round := 0; round < 8; round++ {
		switch negotiation.Requirement {
		case captureplane.NegotiationNotRequired:
			return nil
		case captureplane.NegotiationRemoteAnswer:
			return recorder.ApplyRemoteAnswer(ctx, negotiation)
		case captureplane.NegotiationAnswerNeeded:
			answer, err := recorder.AnswerRemoteOffer(ctx, negotiation)
			if err != nil {
				return fmt.Errorf("answer provider offer: %w", err)
			}
			result, err := adapter.RenegotiateCaptureConnection(ctx, captureplane.RenegotiateCaptureConnectionInput{
				Metadata: liveCaptureMetadata(identity, fmt.Sprintf("live-answer-%d-%s", round, suffix)), Connection: connection,
				NegotiationID: negotiation.ID, Description: answer,
			})
			if err != nil {
				return fmt.Errorf("send provider answer: %w", err)
			}
			negotiation = result.Negotiation
		case captureplane.NegotiationOfferNeeded:
			offer, err := recorder.CreateLocalOffer(ctx, negotiation.ID)
			if err != nil {
				return fmt.Errorf("create recorder offer: %w", err)
			}
			if offer.Description == nil {
				return fmt.Errorf("recorder offer description is missing")
			}
			result, err := adapter.RenegotiateCaptureConnection(ctx, captureplane.RenegotiateCaptureConnectionInput{
				Metadata: liveCaptureMetadata(identity, fmt.Sprintf("live-offer-%d-%s", round, suffix)), Connection: connection,
				NegotiationID: negotiation.ID, Description: *offer.Description,
			})
			if err != nil {
				return fmt.Errorf("send recorder offer: %w", err)
			}
			negotiation = result.Negotiation
		default:
			return fmt.Errorf("unsupported negotiation requirement %q", negotiation.Requirement)
		}
	}
	return fmt.Errorf("capture negotiation exceeded 8 rounds")
}

func writeLiveCaptureMedia(ctx context.Context, audio, video *webrtc.TrackLocalStaticRTP, output chan<- error) {
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	var sequence uint16
	var audioTimestamp, videoTimestamp uint32
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sequence++
			if err := audio.WriteRTP(&rtp.Packet{Header: rtp.Header{
				Version: 2, SequenceNumber: sequence, Timestamp: audioTimestamp, SSRC: 1001,
			}, Payload: []byte{0xf8, 0xff, 0xfe}}); err != nil {
				select {
				case output <- fmt.Errorf("write Opus RTP: %w", err):
				default:
				}
				return
			}
			if err := video.WriteRTP(&rtp.Packet{Header: rtp.Header{
				Version: 2, SequenceNumber: sequence, Timestamp: videoTimestamp, SSRC: 2001, Marker: true,
			}, Payload: []byte{0x10, 0, 0}}); err != nil {
				select {
				case output <- fmt.Errorf("write VP8 RTP: %w", err):
				default:
				}
				return
			}
			audioTimestamp += 960
			videoTimestamp += 1_800
		}
	}
}
