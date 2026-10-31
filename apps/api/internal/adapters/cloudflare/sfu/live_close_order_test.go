package sfu_test

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
	cloudflaresfu "github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// This opt-in development-SFU probe compares the same forced close before and
// after endpoint teardown. It never infers provider closure from local state.
func TestLiveCloudflareSFUCloseOrder(t *testing.T) {
	if os.Getenv("CHALK_RUN_LIVE_SFU_CLOSE_TEST") != "1" {
		t.Skip("CHALK_RUN_LIVE_SFU_CLOSE_TEST is not enabled")
	}
	adapter, err := cloudflaresfu.NewAdapter(config.CloudflareRealtimeConfig{
		RealtimeAppID: os.Getenv(config.CloudflareRealtimeAppID), RealtimeAppSecret: os.Getenv(config.CloudflareRealtimeAppSecret), RequestTimeout: 15 * time.Second,
	})
	if err != nil {
		t.Fatal("create adapter:", err)
	}
	for trial := range 3 {
		for _, peerFirst := range []bool{false, true} {
			t.Run(fmt.Sprintf("trial_%d/peer_first_%t", trial, peerFirst), func(t *testing.T) {
				ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
				defer cancel()
				peer, err := webrtc.NewPeerConnection(webrtc.Configuration{ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:stun.cloudflare.com:3478"}}}})
				if err != nil {
					t.Fatal(err)
				}
				defer peer.Close()
				track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48_000, Channels: 2}, "close-order-audio", "close-order")
				if err != nil {
					t.Fatal(err)
				}
				sender, err := peer.AddTrack(track)
				if err != nil {
					t.Fatal(err)
				}
				connected := make(chan struct{}, 1)
				peer.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
					if state == webrtc.PeerConnectionStateConnected {
						select {
						case connected <- struct{}{}:
						default:
						}
					}
				})
				offer, err := peer.CreateOffer(nil)
				if err != nil {
					t.Fatal(err)
				}
				gathered := webrtc.GatheringCompletePromise(peer)
				if err := peer.SetLocalDescription(offer); err != nil {
					t.Fatal(err)
				}
				select {
				case <-gathered:
				case <-ctx.Done():
					t.Fatal("ICE gathering:", ctx.Err())
				}
				join, err := adapter.CreateJoin(ctx, mediaplane.CreateJoinInput{Provider: mediaplane.ProviderCloudflareSFU, Episode: mediaplane.Episode{Provider: mediaplane.ProviderCloudflareSFU, Ref: "close-order"}, ParticipantName: "close-order", ExternalParticipantID: "close-order", ParticipantPreset: "close-order"})
				if err != nil {
					t.Fatal("create session:", err)
				}
				connection := join.ClientPayload["connectionId"].(string)
				mid := liveSenderMID(t, peer, sender)
				closeTracks := func() (mediaplane.CloseTracksResponse, error) {
					return adapter.CloseTracks(ctx, mediaplane.CloseTracksRequest{Provider: mediaplane.ProviderCloudflareSFU, ConnectionID: connection, Tracks: []mediaplane.CloseTrack{{Mid: mid}}, Force: true})
				}
				defer func() {
					if _, err := closeTracks(); err != nil {
						t.Error("cleanup:", err)
					}
				}()
				published, err := adapter.AddTracks(ctx, mediaplane.TracksRequest{ConnectionID: connection, SessionDescription: &mediaplane.SessionDescription{Type: "offer", SDP: peer.LocalDescription().SDP}, Tracks: []mediaplane.Track{{Location: "local", Mid: mid, TrackName: "close-order-audio", Source: "microphone"}}})
				if err != nil {
					t.Fatal("publish:", err)
				}
				if err := peer.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: published.SessionDescription.SDP}); err != nil {
					t.Fatal(err)
				}
				select {
				case <-connected:
				case <-ctx.Done():
					t.Fatal("connect:", ctx.Err())
				}
				if peerFirst {
					if err := peer.Close(); err != nil {
						t.Fatal(err)
					}
				}
				started := time.Now()
				closed, err := closeTracks()
				if err != nil {
					t.Fatal("close:", err)
				}
				t.Logf("close_order peer_first=%t elapsed_ms=%d already_closed=%t", peerFirst, time.Since(started).Milliseconds(), closed.AlreadyClosed)
			})
		}
	}
}
