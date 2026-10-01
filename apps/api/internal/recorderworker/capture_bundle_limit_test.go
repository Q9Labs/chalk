package recorderworker

import (
	"bytes"
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

// One packetized screen keyframe bursts past the aggregate limit alongside
// two camera layers. The boundary must not discard the accepted fragment or
// the packet that belongs in the next bundle, including after epoch recovery.
func TestCaptureBundleWriterRotatesLargeVP8BurstAcrossEpochs(t *testing.T) {
	for _, schema := range []string{recordingbundle.LegacyVersion, recordingbundle.Version} {
		t.Run(schema, func(t *testing.T) {
			const payloadSize = 1200
			frame := bytes.Repeat([]byte{0x55}, int(recordingbundle.MaxContentBytes)+300_000)
			copy(frame, []byte{0, 0, 0, 0x9d, 1, 0x2a, 0x80, 0x07, 0x38, 0x04})
			payloader := codecs.VP8Payloader{EnablePictureID: true}
			payloads := payloader.Payload(payloadSize, frame)
			for _, epoch := range []uint64{1, 2} {
				origin := time.UnixMilli(1000).UTC()
				writer, storage := newCaptureTestWriter(t, origin)
				writer.attempt.authority.CaptureEpoch = captureplane.CaptureEpoch(epoch)
				writer.attempt.authority.Envelope.BundleSchemaVersion = schema
				tracks := []*captureTestTrack{}
				for i, layer := range []captureplane.TrackLayer{captureplane.TrackLayerHigh, captureplane.TrackLayerLow, captureplane.TrackLayerAuto} {
					track := &captureTestTrack{capture: captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{TrackReference: captureplane.ProviderReference(fmt.Sprintf("track-%d", i)), OwnerReference: "owner", Kind: captureplane.TrackKindVideo, RequestedLayer: layer}, MID: captureplane.ProviderReference(fmt.Sprint(i))}, codec: "vp8"}
					activateCaptureTestTrack(writer, track, origin, epoch)
					tracks = append(tracks, track)
				}
				expected := make(map[string][][]byte)
				addPacket := func(trackIndex, index int, payload []byte, marker bool) {
					track := tracks[trackIndex]
					id := track.CaptureTrack().TrackReference.String()
					sequence := uint16(len(expected[id]) + 1)
					packet := &rtp.Packet{Header: rtp.Header{SequenceNumber: sequence, Timestamp: 9000, SSRC: uint32(trackIndex + 1), PayloadType: 96, Marker: marker}, Payload: payload}
					if err := writer.addPacket(context.Background(), track, packet, origin.Add(time.Duration(index)*time.Millisecond)); err != nil {
						t.Fatalf("epoch %d packet %d: %v", epoch, index, err)
					}
					expected[id] = append(expected[id], payload)
				}
				camera := (&codecs.VP8Payloader{EnablePictureID: true}).Payload(payloadSize, frame[:20])[0]
				for i, payload := range payloads {
					addPacket(2, i, payload, i == len(payloads)-1)
					if i%100 == 0 {
						addPacket(0, i, camera, true)
						addPacket(1, i, camera, true)
					}
				}
				if err := writer.close(recordingbundle.CloseReasonFinalStop, origin.Add(8*time.Second)); err != nil {
					t.Fatal(err)
				}
				if len(storage.uploadHistory) < 2 {
					t.Fatalf("epoch %d uploads=%d, want at least 2", epoch, len(storage.uploadHistory))
				}
				actual := make(map[string][][]byte)
				mediaBundles := 0
				for index, upload := range storage.uploadHistory {
					bundle, err := recordingbundle.Decrypt(bytesOf(0x41), upload.Body)
					if err != nil {
						t.Fatal(err)
					}
					if bundle.Version != schema || bundle.Manifest.CaptureEpoch != epoch {
						t.Fatalf("wrong schema/epoch: %+v", bundle.Manifest)
					}
					if index == 0 && bundle.Manifest.CloseReason != recordingbundle.CloseReasonLimitExceeded {
						t.Fatalf("close reason=%s", bundle.Manifest.CloseReason)
					}
					total := 0
					if len(bundle.Fragments) > 0 {
						mediaBundles++
					}
					for _, fragment := range bundle.Fragments {
						for _, packet := range fragment.Packets {
							total += len(packet.Payload)
							actual[fragment.Track.TrackID] = append(actual[fragment.Track.TrackID], packet.Payload)
						}
					}
					if total > int(recordingbundle.MaxContentBytes) {
						t.Fatalf("payload bytes=%d", total)
					}
				}
				if mediaBundles != 2 {
					t.Fatalf("media bundles=%d, want 2", mediaBundles)
				}
				for id, packets := range expected {
					if len(actual[id]) != len(packets) {
						t.Fatalf("%s packet count=%d, want %d", id, len(actual[id]), len(packets))
					}
					for i, payload := range packets {
						if !bytes.Equal(actual[id][i], payload) {
							t.Fatalf("%s packet %d changed across limit", id, i)
						}
					}
				}
			}
		})
	}
}
