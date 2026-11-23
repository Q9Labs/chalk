package pion

import (
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

func TestRecorderAcceptsLatePrimaryVideoRepair(t *testing.T) {
	api, err := newRecorderAPI()
	if err != nil {
		t.Fatal(err)
	}
	receiver, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = receiver.Close() })
	tracks := make(chan *webrtc.TrackRemote, 1)
	receiver.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		tracks <- track
	})

	sender, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sender.Close() })
	stream, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "camera", "publisher")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sender.AddTrack(stream); err != nil {
		t.Fatal(err)
	}
	connected := make(chan struct{}, 1)
	sender.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateConnected {
			connected <- struct{}{}
		}
	})

	offer, err := sender.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	setGatheredDescription(t, sender, offer)
	if err := receiver.SetRemoteDescription(*sender.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	answer, err := receiver.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	setGatheredDescription(t, receiver, answer)
	if err := sender.SetRemoteDescription(*receiver.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-connected:
	case <-time.After(5 * time.Second):
		t.Fatal("sender did not connect")
	}

	send := func(seq uint16) {
		t.Helper()
		packet := &rtp.Packet{
			Header:  rtp.Header{Version: 2, SequenceNumber: seq, Timestamp: uint32(seq) * 3000},
			Payload: []byte{0x10, 0x00},
		}
		if err := stream.WriteRTP(packet); err != nil {
			t.Fatalf("send packet %d: %v", seq, err)
		}
	}
	send(1000)
	var track *webrtc.TrackRemote
	select {
	case track = <-tracks:
	case <-time.After(5 * time.Second):
		t.Fatal("recorder did not bind the video track")
	}
	read := func(want uint16) {
		t.Helper()
		if err := track.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
			t.Fatal(err)
		}
		packet, _, err := track.ReadRTP()
		if err != nil {
			t.Fatalf("read packet %d: %v", want, err)
		}
		if packet.SequenceNumber != want {
			t.Fatalf("read packet %d, want %d", packet.SequenceNumber, want)
		}
	}
	read(1000)
	// A primary SSRC repair uses the lost packet's original sequence number.
	for seq := uint16(1002); seq <= 1070; seq++ {
		send(seq)
		read(seq)
	}
	send(1001)
	send(1071)
	read(1001)
	send(1001)
	send(1072)
	read(1071)
	read(1072)
}

func setGatheredDescription(t *testing.T, peer *webrtc.PeerConnection, sdp webrtc.SessionDescription) {
	t.Helper()
	gathered := webrtc.GatheringCompletePromise(peer)
	if err := peer.SetLocalDescription(sdp); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gathered:
	case <-time.After(5 * time.Second):
		t.Fatal("peer did not gather ICE candidates")
	}
}
