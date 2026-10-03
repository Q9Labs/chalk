package recorderworker

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"io"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

func TestCaptureReaderE26PacketAdmissionParity(t *testing.T) {
	packets := readE26CameraFixture(t)
	if len(packets) != 11216 {
		t.Fatalf("fixture packets = %d, want 11216", len(packets))
	}
	origin := time.UnixMilli(1000).UTC()
	arrivals := make(map[*rtp.Packet]time.Time, len(packets))
	for index, packet := range packets {
		arrivals[packet] = origin.Add(time.Duration(index) * 3 * time.Millisecond)
	}
	var legacyPackets []recordingbundle.RTPPacket
	var legacyBytes int
	for _, schema := range []string{recordingbundle.LegacyVersion, recordingbundle.Version} {
		t.Run(schema, func(t *testing.T) {
			writer, storage := newCaptureTestWriter(t, origin)
			writer.attempt.authority.Envelope.BundleSchemaVersion = schema
			key := bytes.Clone(storage.key)
			track := &captureTestTrack{capture: captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{
				TrackReference: "camera", OwnerReference: "owner", Kind: captureplane.TrackKindVideo, RequestedLayer: captureplane.TrackLayerAuto,
			}, MID: "0"}, codec: "vp8", readErr: io.EOF, packets: packets}
			activateCaptureTestTrack(writer, track, origin, 2)
			readCapturePackets(t, track, func(event captureRuntimeEvent) {
				// Bundles retain packet ordering, not per-packet arrival times.
				// A deterministic arrival clock forces several bundle rotations.
				at := arrivals[event.packet]
				if err := writer.addPacket(context.Background(), track, event.packet, at); err != nil {
					t.Fatal(err)
				}
			})
			if err := writer.close(recordingbundle.CloseReasonFinalStop, origin.Add(time.Duration(len(packets))*3*time.Millisecond)); err != nil {
				t.Fatal(err)
			}
			var stored []recordingbundle.RTPPacket
			var storedBytes int
			if len(storage.uploadHistory) < 2 {
				t.Fatal("replay did not exercise bundle rotation")
			}
			for _, upload := range storage.uploadHistory {
				storedBytes += len(upload.Body)
				bundle, err := recordingbundle.Decrypt(key, upload.Body)
				if err != nil {
					t.Fatal(err)
				}
				if bundle.Version != schema {
					t.Fatalf("stored schema = %s, want %s", bundle.Version, schema)
				}
				for _, fragment := range bundle.Fragments {
					stored = append(stored, fragment.Packets...)
				}
			}
			t.Logf("input=%d admitted=%d encrypted bytes=%d bundles=%d", len(packets), len(stored), storedBytes, len(storage.uploadHistory))
			if len(stored) != 3109 {
				t.Errorf("admitted %d packets, want 3109 packets (8107 stale replays rejected; equal fragments in the current frame preserved)", len(stored))
			}
			if schema == recordingbundle.LegacyVersion {
				legacyPackets, legacyBytes = stored, storedBytes
				return
			}
			if !reflect.DeepEqual(stored, legacyPackets) {
				t.Error("v1 and v2 admitted different packets")
			}
			if storedBytes >= legacyBytes {
				t.Errorf("v2 encrypted bytes %d >= v1 %d", storedBytes, legacyBytes)
			}
		})
	}
}

func readE26CameraFixture(t *testing.T) []*rtp.Packet {
	t.Helper()
	file, err := os.Open("testdata/capture-e26-camera.rtp.gz")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	reader, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	var packets []*rtp.Packet
	var row [13]byte
	for {
		_, err := io.ReadFull(reader, row[:])
		if err == io.EOF {
			return packets
		}
		if err != nil {
			t.Fatal(err)
		}
		payload := make([]byte, binary.BigEndian.Uint16(row[6:8]))
		seed := sha256.Sum256(row[8:12])
		for index := range payload {
			payload[index] = seed[index%len(seed)]
		}
		packets = append(packets, &rtp.Packet{Header: rtp.Header{
			Version: 2, SSRC: 1, PayloadType: 96,
			SequenceNumber: binary.BigEndian.Uint16(row[:2]), Timestamp: binary.BigEndian.Uint32(row[2:6]), Marker: row[12] != 0,
		}, Payload: payload})
	}
}

func TestCaptureReaderReplayKeepsNewMediaAndRepairs(t *testing.T) {
	for _, kind := range []captureplane.TrackKind{captureplane.TrackKindVideo, captureplane.TrackKindAudio} {
		t.Run(string(kind), func(t *testing.T) {
			track := &captureTestTrack{capture: captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{Kind: kind}, MID: "0"}, readErr: io.EOF}
			for _, packet := range []rtp.Packet{
				{Header: rtp.Header{SSRC: 1, SequenceNumber: 65533, Timestamp: 100}, Payload: []byte{1}},
				// Equal fragments within the current frame can be legitimate.
				{Header: rtp.Header{SSRC: 1, SequenceNumber: 65534, Timestamp: 100}, Payload: []byte{1}},
				{Header: rtp.Header{SSRC: 1, SequenceNumber: 0, Timestamp: 200}, Payload: []byte{1}},
				// Previously unseen repair of an equal fragment, late across the wrap.
				{Header: rtp.Header{SSRC: 1, SequenceNumber: 65535, Timestamp: 100}, Payload: []byte{1}},
				// A replay with a new sequence, followed by distinct metadata/payload.
				{Header: rtp.Header{SSRC: 1, SequenceNumber: 1, Timestamp: 100}, Payload: []byte{1}},
				{Header: rtp.Header{SSRC: 1, SequenceNumber: 2, Timestamp: 100, Marker: true}, Payload: []byte{1}},
				{Header: rtp.Header{SSRC: 1, SequenceNumber: 3, Timestamp: 100, PayloadType: 96}, Payload: []byte{1}},
				{Header: rtp.Header{SSRC: 1, SequenceNumber: 4, Timestamp: 100}, Payload: []byte{3}},
				// The replacement source owns a new media/sequence space.
				{Header: rtp.Header{SSRC: 2, SequenceNumber: 1, Timestamp: 100}, Payload: []byte{1}},
			} {
				track.packets = append(track.packets, &packet)
			}
			var got []uint16
			readCapturePackets(t, track, func(event captureRuntimeEvent) {
				got = append(got, event.packet.SequenceNumber)
			})
			want := []uint16{65533, 65534, 0, 65535, 2, 3, 4, 1}
			if kind == captureplane.TrackKindAudio {
				want = []uint16{65533, 65534, 0, 65535, 1, 2, 3, 4, 1}
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("admitted sequences = %v, want %v", got, want)
			}
		})
	}
}

func TestCaptureVideoReplayWindowWrapAndBound(t *testing.T) {
	var window captureVideoReplayWindow
	packet := func(timestamp uint32) *rtp.Packet {
		return &rtp.Packet{Header: rtp.Header{SSRC: 1, Timestamp: timestamp}, Payload: []byte{1}}
	}
	beforeWrap := packet(0xfffffff0)
	if !window.accept(beforeWrap, true) || !window.accept(packet(10), true) || window.accept(beforeWrap, true) {
		t.Fatal("timestamp wrap did not preserve new media and reject older replay")
	}
	// Repeating one old packet cannot evict history or grow the cache.
	for range captureVideoReplayPackets + 1 {
		if window.accept(beforeWrap, true) {
			t.Fatal("replay evicted its own history")
		}
	}
	for index := range captureVideoReplayPackets {
		if !window.accept(packet(uint32(index+11)), true) {
			t.Fatal("new media rejected")
		}
	}
	if len(window.seen) != captureVideoReplayPackets || len(window.order) != captureVideoReplayPackets {
		t.Fatalf("unbounded history: %d fingerprints, %d queue entries", len(window.seen), len(window.order))
	}
	if !window.accept(beforeWrap, true) {
		t.Fatal("packet outside the bounded history was rejected")
	}
	if window.accept(packet(captureVideoReplayPackets), true) {
		t.Fatal("recent older-frame replay was admitted")
	}
}
