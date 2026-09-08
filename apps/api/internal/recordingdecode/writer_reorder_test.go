package recordingdecode

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

func TestIngestBundlesMergesLateCrossBundlePacketsAndExactRepeats(t *testing.T) {
	t.Parallel()

	const (
		recordingID = "00000000-0000-4000-8000-000000000001"
		episodeID   = "00000000-0000-4000-8000-000000000002"
		tenantID    = "00000000-0000-4000-8000-000000000003"
		jobID       = "00000000-0000-4000-8000-000000000004"
		trackID     = "microphone-track"
		sourceID    = "source-1"
	)
	key := bytes.Repeat([]byte{0x31}, 32)
	envelope := strings.Repeat("11", 32)
	track := recordingbundle.TrackIdentity{TrackID: trackID, Epoch: 1, MID: "0", Codec: "opus", Layer: "primary"}
	packet := func(sequence uint64, timestamp uint32, payload string) recordingbundle.RTPPacket {
		return testSpoolPacket(sequence, timestamp, []byte(payload))
	}
	bundles := []recordingbundle.Bundle{
		testMergeBundle(recordingID, episodeID, tenantID, jobID, envelope, track, 0, 0, 10, []recordingbundle.RTPPacket{
			packet(10, 100, "ten"), packet(10, 100, "ten"), packet(12, 120, "twelve"),
		}),
		testMergeBundle(recordingID, episodeID, tenantID, jobID, envelope, track, 1, 10, 20, []recordingbundle.RTPPacket{
			packet(11, 110, "late-eleven"), packet(12, 120, "twelve"), packet(13, 130, "thirteen"),
		}),
	}
	root := t.TempDir()
	files := make([]BundleFile, 0, len(bundles))
	for index, bundle := range bundles {
		encoded, err := recordingbundle.Encrypt(key, bundle)
		if err != nil {
			t.Fatalf("encrypt bundle %d: %v", index, err)
		}
		path := filepath.Join(root, "bundle-"+strconv.Itoa(index))
		if err := os.WriteFile(path, encoded, 0o600); err != nil {
			t.Fatal(err)
		}
		files = append(files, BundleFile{
			Path: path, ExpectedSHA256: recordingbundle.ObjectChecksumHex(encoded), Sequence: uint64(index),
			CaptureEpoch: 1, CaptureJobID: jobID, RecorderEnvelopeDigest: envelope,
		})
	}
	request := Request{
		RecordingID: recordingID, EpisodeID: episodeID, TenantID: tenantID, Environment: "test",
		CaptureEpoch: 1, DurationMS: 1_000, Bundles: files, DataKeys: []DataKey{{CaptureEpoch: 1, Plaintext: key}},
	}
	catalog := map[sourceIdentity]recordingpresentation.MediaSource{
		{trackID: trackID, epoch: 1}: {
			SourceID: sourceID, ParticipantID: "participant-1", ParticipantGeneration: 1,
			Kind: recordingpresentation.MediaKindMicrophone, TrackID: trackID, Epoch: 1, Visible: true,
		},
	}
	spoolDirectory := filepath.Join(root, "spool")
	if err := os.Mkdir(spoolDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	states, _, err := ingestBundles(context.Background(), request, catalog, spoolDirectory)
	if err != nil {
		t.Fatalf("ingestBundles() error = %v", err)
	}
	packets := readTestSpool(t, states[sourceID].spoolPath)
	assertTestSpoolPackets(t, packets,
		[]uint64{10, 11, 12, 13},
		[][]byte{[]byte("ten"), []byte("late-eleven"), []byte("twelve"), []byte("thirteen")},
	)
}

func TestIngestBundlesResetsSourceAfterRecoveryBoundaryWhereSourceWasAbsent(t *testing.T) {
	t.Parallel()

	const (
		recordingID = "00000000-0000-4000-8000-000000000011"
		episodeID   = "00000000-0000-4000-8000-000000000012"
		tenantID    = "00000000-0000-4000-8000-000000000013"
		jobID       = "00000000-0000-4000-8000-000000000014"
	)
	key := bytes.Repeat([]byte{0x41}, 32)
	envelopeBefore := strings.Repeat("11", 32)
	envelopeAfter := strings.Repeat("22", 32)
	trackA := recordingbundle.TrackIdentity{TrackID: "track-a", Epoch: 1, MID: "0", Codec: "opus", Layer: "primary"}
	trackB := recordingbundle.TrackIdentity{TrackID: "track-b", Epoch: 1, MID: "1", Codec: "opus", Layer: "primary"}
	bundles := []recordingbundle.Bundle{
		testMergeBundle(recordingID, episodeID, tenantID, jobID, envelopeBefore, trackA, 0, 0, 10, []recordingbundle.RTPPacket{
			testSpoolPacket(100, 100, []byte("before-recovery")),
		}),
		testMergeBundle(recordingID, episodeID, tenantID, jobID, envelopeAfter, trackB, 1, 10, 20, []recordingbundle.RTPPacket{
			testSpoolPacket(5, 110, []byte("other-source")),
		}),
		testMergeBundle(recordingID, episodeID, tenantID, jobID, envelopeAfter, trackA, 2, 20, 30, []recordingbundle.RTPPacket{
			testSpoolPacket(10, 120, []byte("after-recovery")),
		}),
	}
	root := t.TempDir()
	files := make([]BundleFile, 0, len(bundles))
	for index, bundle := range bundles {
		encoded, err := recordingbundle.Encrypt(key, bundle)
		if err != nil {
			t.Fatalf("encrypt bundle %d: %v", index, err)
		}
		path := filepath.Join(root, "bundle-"+strconv.Itoa(index))
		if err := os.WriteFile(path, encoded, 0o600); err != nil {
			t.Fatal(err)
		}
		files = append(files, BundleFile{
			Path: path, ExpectedSHA256: recordingbundle.ObjectChecksumHex(encoded), Sequence: uint64(index),
			CaptureEpoch: 1, CaptureJobID: jobID, RecorderEnvelopeDigest: bundle.Manifest.RecorderEnvelopeDigest,
		})
	}
	request := Request{
		RecordingID: recordingID, EpisodeID: episodeID, TenantID: tenantID, Environment: "test",
		CaptureEpoch: 1, DurationMS: 1_000, Bundles: files, DataKeys: []DataKey{{CaptureEpoch: 1, Plaintext: key}},
	}
	catalog := map[sourceIdentity]recordingpresentation.MediaSource{
		{trackID: trackA.TrackID, epoch: trackA.Epoch}: {
			SourceID: "source-a", ParticipantID: "participant-1", ParticipantGeneration: 1,
			Kind: recordingpresentation.MediaKindMicrophone, TrackID: trackA.TrackID, Epoch: int64(trackA.Epoch), Visible: true,
		},
		{trackID: trackB.TrackID, epoch: trackB.Epoch}: {
			SourceID: "source-b", ParticipantID: "participant-1", ParticipantGeneration: 1,
			Kind: recordingpresentation.MediaKindMicrophone, TrackID: trackB.TrackID, Epoch: int64(trackB.Epoch), Visible: true,
		},
	}
	spoolDirectory := filepath.Join(root, "spool")
	if err := os.Mkdir(spoolDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	states, _, err := ingestBundles(context.Background(), request, catalog, spoolDirectory)
	if err != nil {
		t.Fatalf("ingestBundles() error = %v", err)
	}
	packets := readTestSpool(t, states["source-a"].spoolPath)
	assertTestSpoolPackets(t, packets,
		[]uint64{100, 10},
		[][]byte{[]byte("before-recovery"), []byte("after-recovery")},
	)
}

func testMergeBundle(recordingID, episodeID, tenantID, jobID, envelope string, track recordingbundle.TrackIdentity, sequence uint64, start, end int64, packets []recordingbundle.RTPPacket) recordingbundle.Bundle {
	return recordingbundle.Bundle{
		Version: recordingbundle.Version,
		Manifest: recordingbundle.Manifest{
			Version: recordingbundle.Version, RecordingID: recordingID, CaptureEpoch: 1, Sequence: sequence,
			RecorderEnvelopeDigest: envelope,
			MonotonicRange:         recordingbundle.TimeRange{StartMilliseconds: start, EndMilliseconds: end},
			MediaRange:             recordingbundle.TimeRange{StartMilliseconds: start, EndMilliseconds: end},
			CloseReason:            recordingbundle.CloseReasonExplicit, AllocationVersion: 1,
			Encryption: recordingbundle.EncryptionContext{
				Environment: "test", TenantID: tenantID, EpisodeID: episodeID, RecordingID: recordingID,
				JobID: jobID, BundleSchema: recordingbundle.Version,
			},
		},
		Fragments: []recordingbundle.RTPFragment{{Track: track, Packets: packets}},
	}
}

func testSpoolPacket(sequence uint64, timestamp uint32, payload []byte) recordingbundle.RTPPacket {
	return recordingbundle.RTPPacket{
		SequenceNumber: uint16(sequence), ExtendedSequenceNumber: sequence,
		Timestamp: timestamp, SSRC: 7, PayloadType: 96, Marker: true,
		Payload: append([]byte(nil), payload...),
	}
}

func readTestSpool(t *testing.T, path string) []recordingbundle.RTPPacket {
	t.Helper()
	var packets []recordingbundle.RTPPacket
	if err := readSpool(path, func(packet recordingbundle.RTPPacket) error {
		packet.Payload = append([]byte(nil), packet.Payload...)
		packets = append(packets, packet)
		return nil
	}); err != nil {
		t.Fatalf("readSpool() error = %v", err)
	}
	return packets
}

func assertTestSpoolPackets(t *testing.T, packets []recordingbundle.RTPPacket, sequences []uint64, payloads [][]byte) {
	t.Helper()
	if len(packets) != len(sequences) || len(packets) != len(payloads) {
		t.Fatalf("packet count = %d, sequences = %d, payloads = %d", len(packets), len(sequences), len(payloads))
	}
	for index, packet := range packets {
		if packet.ExtendedSequenceNumber != sequences[index] || !bytes.Equal(packet.Payload, payloads[index]) {
			t.Fatalf("packet %d = sequence %d payload %q, want sequence %d payload %q", index, packet.ExtendedSequenceNumber, packet.Payload, sequences[index], payloads[index])
		}
	}
}
