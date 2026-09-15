package recorderworker

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

// BenchmarkCaptureThreeParticipantsHour exercises the actual bounded RTP bundler,
// encryption and upload handoff at compressed time. It does not qualify an SFU,
// video decoder, shared-CPU cloud SKU, or real-time network behavior.
func BenchmarkCaptureThreeParticipantsHour(b *testing.B) {
	const payloadBytes = 1_100
	const recordingBytes = 4_000_000 / 8 * 3_600
	const packetCount = recordingBytes / payloadBytes
	origin := time.Unix(1_700_000_000, 0)
	for range b.N {
		storage := &captureProfileStorage{}
		attempt := &PionCaptureAttempt{
			authority: recordercapture.AttemptAuthority{
				TenantID:     captureTestID(b, "22222222-2222-4222-8222-222222222222"),
				EpisodeID:    captureTestID(b, "44444444-4444-4444-8444-444444444444"),
				RecordingID:  captureTestID(b, "55555555-5555-4555-8555-555555555555"),
				JobID:        captureTestID(b, "66666666-6666-4666-8666-666666666666"),
				CaptureEpoch: 1, AttemptCount: 1, FencingGeneration: 1,
				Envelope: recordingpipeline.RecorderJobEnvelope{KeyHandle: "synthetic-key"}, EnvelopeDigest: bytesOf(0x42),
			},
			lease: capturesignaling.WorkerLease{Token: "synthetic-lease"},
			keys:  storage, objects: storage, bundles: storage,
			config: CaptureAttemptConfig{Now: func() time.Time { return origin }}.normalized(),
		}
		writer := newCaptureBundleWriter(attempt)
		tracks := make([]*captureTestTrack, 0, 6)
		for index := range 6 {
			kind, codec := captureplane.TrackKindVideo, "vp8"
			if index%2 == 0 {
				kind, codec = captureplane.TrackKindAudio, "opus"
			}
			track := &captureTestTrack{capture: captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{
				TrackReference: captureplane.ProviderReference(fmt.Sprintf("track-%d", index)),
				OwnerReference: captureplane.ProviderReference(fmt.Sprintf("participant-%d", index/2)),
				Kind:           kind, RequestedLayer: captureplane.TrackLayerAuto,
			}, MID: captureplane.ProviderReference(fmt.Sprint(index))}, codec: codec}
			activateCaptureTestTrack(writer, track, origin, 1)
			tracks = append(tracks, track)
		}
		payload := make([]byte, payloadBytes)
		for index := range payload {
			payload[index] = byte(index % 251)
		}
		for index := range packetCount {
			at := origin.Add(time.Duration(index) * time.Hour / packetCount)
			track := tracks[index%len(tracks)]
			clockRate := int64(90_000)
			if track.CaptureTrack().Kind == captureplane.TrackKindAudio {
				clockRate = 48_000
			}
			timestamp := uint32(at.Sub(origin).Nanoseconds() * clockRate / int64(time.Second))
			packet := &rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: uint16(index / 6), Timestamp: timestamp}, Payload: payload}
			if err := writer.addPacket(context.Background(), track, packet, at); err != nil {
				b.Fatal(err)
			}
		}
		if err := writer.close(recordingbundle.CloseReasonFinalStop, origin.Add(time.Hour)); err != nil {
			b.Fatal(err)
		}
		if storage.uploads == 0 || storage.uploads != storage.commits || storage.uploadedBytes < packetCount*payloadBytes {
			b.Fatalf("incomplete upload handoff: %+v", storage)
		}
		b.ReportMetric(float64(storage.uploads), "bundles/hour")
	}
	b.SetBytes(packetCount * payloadBytes)
	b.ReportAllocs()
}

// The sink discards completed objects instead of retaining an hour of media in
// the test process. All inputs are synthetic; no credentials or network are used.
type captureProfileStorage struct {
	sequence                        uint64
	uploads, commits, uploadedBytes int
}

func (*captureProfileStorage) AccessKey(context.Context, CaptureKeyRequest) (CaptureDataKey, error) {
	return CaptureDataKey{Plaintext: make([]byte, 32), EncryptionContextDigest: bytesOf(0xcd)}, nil
}
func (s *captureProfileStorage) Reserve(context.Context, BundleReserveRequest) (BundleReservation, error) {
	sequence := s.sequence
	s.sequence++
	return BundleReservation{ReservationID: "synthetic-allocation", Sequence: sequence, AllocationVersion: 1, ObjectKey: fmt.Sprint("synthetic/", sequence)}, nil
}
func (*captureProfileStorage) Finalize(_ context.Context, input CaptureBundleFinalize) (CaptureBundleUpload, error) {
	return CaptureBundleUpload{Reservation: input.Reservation, UploadToken: "synthetic-upload"}, nil
}
func (s *captureProfileStorage) Upload(_ context.Context, input CaptureObjectUpload) error {
	s.uploads++
	s.uploadedBytes += len(input.Body)
	return nil
}
func (s *captureProfileStorage) Commit(context.Context, CaptureBundleCommit) error {
	s.commits++
	return nil
}
