package recordingbundle

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
)

func testConfig(sequence uint64) AssemblerConfig {
	return AssemblerConfig{
		RecordingID:            "recording-1",
		CaptureEpoch:           1,
		Sequence:               sequence,
		RecorderEnvelopeDigest: "4242424242424242424242424242424242424242424242424242424242424242",
		AllocationVersion:      int64(sequence) + 1,
		Encryption: EncryptionContext{
			Environment:  "test",
			TenantID:     "tenant-1",
			EpisodeID:    "episode-1",
			RecordingID:  "recording-1",
			JobID:        "job-1",
			BundleSchema: Version,
		},
	}
}

func testTrack(id string, epoch uint64, mid string) TrackIdentity {
	return TrackIdentity{TrackID: id, Epoch: epoch, MID: mid, Codec: "opus", Layer: "primary"}
}

func testPacket(track TrackIdentity, monotonic, media int64, sequence uint16, payload ...byte) MediaPacket {
	return MediaPacket{
		Track: track,
		Packet: RTPPacket{
			SequenceNumber:         sequence,
			ExtendedSequenceNumber: uint64(sequence),
			Timestamp:              uint32(sequence) * 960,
			SSRC:                   42,
			PayloadType:            111,
			Payload:                append([]byte(nil), payload...),
		},
		MonotonicMilliseconds: monotonic,
		MediaMilliseconds:     media,
	}
}

func fixtureBundle() Bundle {
	trackA := testTrack("track-a", 1, "0")
	trackB := TrackIdentity{TrackID: "track-b", Epoch: 1, MID: "1", Codec: "vp8", Layer: "high"}
	return Bundle{
		Version: Version,
		Manifest: Manifest{
			Version:                Version,
			RecordingID:            "recording-1",
			CaptureEpoch:           1,
			Sequence:               7,
			RecorderEnvelopeDigest: testConfig(7).RecorderEnvelopeDigest,
			AllocationVersion:      testConfig(7).AllocationVersion,
			MonotonicRange:         TimeRange{StartMilliseconds: 100, EndMilliseconds: 3_100},
			MediaRange:             TimeRange{StartMilliseconds: 200, EndMilliseconds: 3_200},
			CloseReason:            CloseReasonExplicit,
			Encryption:             testConfig(7).Encryption,
		},
		Fragments: []RTPFragment{
			{Track: trackB, Packets: []RTPPacket{
				{SequenceNumber: 4, ExtendedSequenceNumber: 4, Timestamp: 4_000, SSRC: 2, PayloadType: 96, Payload: []byte{4}},
				{SequenceNumber: 3, ExtendedSequenceNumber: 3, Timestamp: 3_000, SSRC: 2, PayloadType: 96, Payload: []byte{3}},
			}},
			{Track: trackA, Packets: []RTPPacket{
				{SequenceNumber: 2, ExtendedSequenceNumber: 2, Timestamp: 2_000, SSRC: 1, PayloadType: 111, Payload: []byte{2}},
				{SequenceNumber: 1, ExtendedSequenceNumber: 1, Timestamp: 1_000, SSRC: 1, PayloadType: 111, Payload: []byte{1}},
			}},
		},
		TrackTimeline: []TrackTimelineEvent{{
			MonotonicMilliseconds: 100,
			MediaMilliseconds:     200,
			Kind:                  TrackEventAdded,
			Track:                 trackA,
			Reason:                "initial",
		}},
		LayoutTimeline: []LayoutTimelineEvent{{
			MonotonicMilliseconds: 200,
			MediaMilliseconds:     300,
			Kind:                  LayoutEventSnapshot,
			Revision:              1,
			Layout:                "speaker:track-a",
		}},
		Gaps: []Gap{{
			StartMonotonicMilliseconds: 1_500,
			EndMonotonicMilliseconds:   1_700,
			StartMediaMilliseconds:     1_600,
			EndMediaMilliseconds:       1_800,
			Reason:                     "worker_replacement",
			ReplacementAttempt:         2,
		}},
	}
}

func TestCanonicalEncodingIsDeterministicAndRoundTrips(t *testing.T) {
	first := fixtureBundle()
	second := fixtureBundle()
	second.Fragments[0], second.Fragments[1] = second.Fragments[1], second.Fragments[0]
	second.Fragments[0].Packets[0], second.Fragments[0].Packets[1] = second.Fragments[0].Packets[1], second.Fragments[0].Packets[0]
	firstBytes, err := Encode(first)
	if err != nil {
		t.Fatalf("encode first: %v", err)
	}
	secondBytes, err := Encode(second)
	if err != nil {
		t.Fatalf("encode second: %v", err)
	}
	if !bytes.Equal(firstBytes, secondBytes) {
		t.Fatal("logically equal bundles have different canonical bytes")
	}
	decoded, err := Decode(firstBytes)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if decoded.ContentDigest == "" || decoded.ManifestDigest == "" || decoded.BundleDigest == "" || decoded.Manifest.RecorderEnvelopeDigest != testConfig(7).RecorderEnvelopeDigest {
		t.Fatal("decoded bundle did not retain all digests")
	}
	checksum, err := ContentChecksum(first)
	if err != nil {
		t.Fatalf("content checksum: %v", err)
	}
	if checksum != decoded.ContentDigest || checksum != decoded.Manifest.ContentSHA256 {
		t.Fatalf("content checksum mismatch: checksum=%s content=%s manifest=%s", checksum, decoded.ContentDigest, decoded.Manifest.ContentSHA256)
	}
}

func TestDecodeRejectsUnknownFieldsVersionsAndTampering(t *testing.T) {
	encoded, err := Encode(fixtureBundle())
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	unknown := append(append([]byte(nil), encoded[:len(encoded)-1]...), []byte(`,"unknown":true}`)...)
	if _, err := Decode(unknown); !errors.Is(err, ErrUnknownField) {
		t.Fatalf("unknown field error = %v", err)
	}

	var wire wireBundle
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatalf("unmarshal fixture: %v", err)
	}
	wire.Version = "recording_bundle.v2"
	versionBytes, err := json.Marshal(wire)
	if err != nil {
		t.Fatalf("marshal version fixture: %v", err)
	}
	if _, err := Decode(versionBytes); !errors.Is(err, ErrUnknownBundleVersion) {
		t.Fatalf("unknown version error = %v", err)
	}

	wire = wireBundle{}
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatalf("unmarshal tamper fixture: %v", err)
	}
	wire.Fragments[0].Packets[0].Payload = []byte("tampered")
	tampered, err := json.Marshal(wire)
	if err != nil {
		t.Fatalf("marshal tamper fixture: %v", err)
	}
	if _, err := Decode(tampered); !errors.Is(err, ErrDigestMismatch) {
		t.Fatalf("tampered error = %v", err)
	}
}

func TestAssemblerCadenceOrdersPacketsAndCopiesPayload(t *testing.T) {
	assembler, err := NewAssembler(testConfig(1))
	if err != nil {
		t.Fatalf("new assembler: %v", err)
	}
	track := testTrack("track-a", 1, "0")
	payload := []byte{2}
	if err := assembler.AddPacket(testPacket(track, 5_000, 5_000, 2, payload...)); err != nil {
		t.Fatalf("add first packet: %v", err)
	}
	payload[0] = 9
	if err := assembler.AddPacket(testPacket(track, 0, 0, 1, 1)); err != nil {
		t.Fatalf("add out-of-order packet: %v", err)
	}
	if assembler.Closed() {
		t.Fatal("assembler closed before cadence")
	}
	if err := assembler.AddPacket(testPacket(track, 10_000, 10_000, 3, 3)); err != nil {
		t.Fatalf("add cadence packet: %v", err)
	}
	sealed, err := assembler.Snapshot()
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if sealed.Bundle.Manifest.CloseReason != CloseReasonCadence {
		t.Fatalf("close reason = %s", sealed.Bundle.Manifest.CloseReason)
	}
	packets := sealed.Bundle.Fragments[0].Packets
	if len(packets) != 3 || packets[0].SequenceNumber != 1 || packets[1].SequenceNumber != 2 || packets[2].SequenceNumber != 3 {
		t.Fatalf("packets were not deterministically ordered: %+v", packets)
	}
	if packets[1].Payload[0] != 2 {
		t.Fatal("assembler retained caller-owned payload")
	}
	if len(sealed.Bytes) == 0 || sealed.PacketCount != 3 {
		t.Fatalf("sealed facts are incomplete: %+v", sealed)
	}
}

func TestAssemblerEarlyTrackChangeStopAndExplicitEpoch(t *testing.T) {
	track := testTrack("track-a", 1, "0")
	assembler, err := NewAssembler(testConfig(2))
	if err != nil {
		t.Fatalf("new assembler: %v", err)
	}
	if err := assembler.AddPacket(testPacket(track, 0, 0, 1, 1)); err != nil {
		t.Fatalf("add packet: %v", err)
	}
	if err := assembler.AddTrackEvent(TrackTimelineEvent{
		MonotonicMilliseconds: 1_000,
		MediaMilliseconds:     1_000,
		Kind:                  TrackEventAdded,
		Track:                 testTrack("track-b", 1, "1"),
		Reason:                "publication_joined",
	}); err != nil {
		t.Fatalf("track change: %v", err)
	}
	sealed, err := assembler.Snapshot()
	if err != nil {
		t.Fatalf("early snapshot: %v", err)
	}
	if sealed.Bundle.Manifest.CloseReason != CloseReasonTrackSetChange || len(sealed.Bundle.TrackTimeline) != 1 {
		t.Fatalf("early closure facts = %+v", sealed.Bundle.Manifest)
	}
	if err := assembler.AddPacket(testPacket(track, 1_100, 1_100, 2, 2)); !errors.Is(err, ErrAssemblerClosed) {
		t.Fatalf("packet after early closure error = %v", err)
	}

	epochAssembler, err := NewAssembler(testConfig(3))
	if err != nil {
		t.Fatalf("new epoch assembler: %v", err)
	}
	if err := epochAssembler.AddPacket(testPacket(track, 0, 0, 3, 3)); err != nil {
		t.Fatalf("epoch base packet: %v", err)
	}
	if err := epochAssembler.AddPacket(testPacket(testTrack("track-a", 2, "0"), 2_000, 2_000, 4, 4)); !errors.Is(err, ErrTrackEpochChangeNeeded) {
		t.Fatalf("implicit epoch change error = %v", err)
	}

	stopper, err := NewAssembler(testConfig(4))
	if err != nil {
		t.Fatalf("new stopper: %v", err)
	}
	if err := stopper.AddPacket(testPacket(track, 500, 500, 4, 4)); err != nil {
		t.Fatalf("stopper packet: %v", err)
	}
	if err := stopper.Stop(2_000, 2_000); err != nil {
		t.Fatalf("stop: %v", err)
	}
	stopped, err := stopper.Seal()
	if err != nil {
		t.Fatalf("stopped seal: %v", err)
	}
	if stopped.Bundle.Manifest.CloseReason != CloseReasonFinalStop || stopped.Bundle.Manifest.MonotonicRange.EndMilliseconds != 2_000 {
		t.Fatalf("stop facts = %+v", stopped.Bundle.Manifest)
	}
}

func TestAssemblerGapsAndLimits(t *testing.T) {
	track := testTrack("track-a", 1, "0")
	assembler, err := NewAssembler(testConfig(5))
	if err != nil {
		t.Fatalf("new assembler: %v", err)
	}
	if err := assembler.AddPacket(testPacket(track, 0, 0, 1, 1)); err != nil {
		t.Fatalf("packet: %v", err)
	}
	gap := Gap{StartMonotonicMilliseconds: 1_000, EndMonotonicMilliseconds: 2_000, StartMediaMilliseconds: 1_000, EndMediaMilliseconds: 2_000, ReplacementAttempt: 2, Reason: "worker_replacement"}
	if err := assembler.AddReplacementGap(gap); err != nil {
		t.Fatalf("replacement gap: %v", err)
	}
	if len(assembler.PendingGaps()) != 1 {
		t.Fatalf("pending gaps = %v", assembler.PendingGaps())
	}
	if err := assembler.CloseNow(CloseReasonExplicit); err != nil {
		t.Fatalf("close first: %v", err)
	}
	queued := assembler.TakePendingGaps()
	if len(queued) != 1 {
		t.Fatalf("drained gaps = %v", queued)
	}
	nextConfig := testConfig(6)
	nextConfig.InitialGaps = queued
	next, err := NewAssembler(nextConfig)
	if err != nil {
		t.Fatalf("new replacement assembler: %v", err)
	}
	if err := next.AddPacket(testPacket(track, 2_000, 2_000, 2, 2)); err != nil {
		t.Fatalf("replacement packet: %v", err)
	}
	if err := next.Stop(3_000, 3_000); err != nil {
		t.Fatalf("replacement stop: %v", err)
	}
	replacement, err := next.Seal()
	if err != nil {
		t.Fatalf("replacement seal: %v", err)
	}
	if len(replacement.Bundle.Gaps) != 1 || replacement.Bundle.Gaps[0].ReplacementAttempt != 2 {
		t.Fatalf("replacement gap missing: %+v", replacement.Bundle.Gaps)
	}

	limited := testConfig(7)
	limited.MaxContentBytes = 2
	bounded, err := NewAssembler(limited)
	if err != nil {
		t.Fatalf("new bounded assembler: %v", err)
	}
	if err := bounded.AddPacket(testPacket(track, 0, 0, 1, 1, 2, 3)); !errors.Is(err, ErrContentLimit) {
		t.Fatalf("content limit error = %v", err)
	}
	if !bounded.Closed() {
		t.Fatal("bounded assembler did not fail closed")
	}
	if _, err := bounded.Snapshot(); !errors.Is(err, ErrContentLimit) {
		t.Fatalf("bounded snapshot error = %v", err)
	}
}

func TestAssemblerConcurrentInputIsRaceSafe(t *testing.T) {
	assembler, err := NewAssembler(testConfig(8))
	if err != nil {
		t.Fatalf("new assembler: %v", err)
	}
	track := testTrack("track-a", 1, "0")
	var wait sync.WaitGroup
	for i := 0; i < 100; i++ {
		i := i
		wait.Add(1)
		go func() {
			defer wait.Done()
			_ = assembler.AddPacket(testPacket(track, int64(i%900), int64(i%900), uint16(i), byte(i)))
		}()
	}
	wait.Wait()
	if err := assembler.Stop(900, 900); err != nil {
		t.Fatalf("concurrent stop: %v", err)
	}
	sealed, err := assembler.Snapshot()
	if err != nil {
		t.Fatalf("concurrent snapshot: %v", err)
	}
	if sealed.PacketCount != 100 {
		t.Fatalf("packet count = %d", sealed.PacketCount)
	}
}

func TestDecodeRejectsDuplicateFields(t *testing.T) {
	encoded, err := Encode(fixtureBundle())
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	duplicate := append(append([]byte(nil), encoded[:len(encoded)-1]...), []byte(`,"version":"recording_bundle.v1"}`)...)
	if _, err := Decode(duplicate); err == nil {
		t.Fatal("duplicate field was accepted")
	}
}

func TestSequenceRequiresStrictIncrease(t *testing.T) {
	first, err := NewAssembler(testConfig(1))
	if err != nil {
		t.Fatalf("new first: %v", err)
	}
	if err := first.AddPacket(testPacket(testTrack("track-a", 1, "0"), 0, 0, 1, 1)); err != nil {
		t.Fatalf("first packet: %v", err)
	}
	if err := first.CloseNow(CloseReasonExplicit); err != nil {
		t.Fatalf("first close: %v", err)
	}
	second, err := NewAssembler(testConfig(2))
	if err != nil {
		t.Fatalf("new second: %v", err)
	}
	if err := second.AddPacket(testPacket(testTrack("track-a", 1, "0"), 0, 0, 2, 2)); err != nil {
		t.Fatalf("second packet: %v", err)
	}
	if err := second.CloseNow(CloseReasonExplicit); err != nil {
		t.Fatalf("second close: %v", err)
	}
	firstSealed, _ := first.Seal()
	secondSealed, _ := second.Seal()
	if secondSealed.Bundle.Manifest.Sequence <= firstSealed.Bundle.Manifest.Sequence {
		t.Fatal("test fixture did not use increasing sequence")
	}
	if err := ValidateSequence(firstSealed.Bundle, secondSealed.Bundle); err != nil {
		t.Fatalf("strict sequence validation: %v", err)
	}
	secondSealed.Bundle.Manifest.Sequence = firstSealed.Bundle.Manifest.Sequence
	if err := ValidateSequence(firstSealed.Bundle, secondSealed.Bundle); err == nil {
		t.Fatal("reused sequence was accepted")
	}
}

func TestEncryptedObjectAuthenticatesBundleAndContext(t *testing.T) {
	key := bytes.Repeat([]byte{0x24}, 32)
	encrypted, err := encryptWithRandom(key, fixtureBundle(), bytes.NewReader(bytes.Repeat([]byte{0x42}, 64)))
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	decrypted, err := Decrypt(key, encrypted)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if decrypted.Manifest.RecorderEnvelopeDigest != fixtureBundle().Manifest.RecorderEnvelopeDigest || decrypted.BundleDigest == "" {
		t.Fatalf("decrypted authority = %+v", decrypted.Manifest)
	}
	digest := sha256.Sum256(encrypted)
	if ObjectChecksumHex(encrypted) != fmt.Sprintf("%x", digest[:]) || ObjectChecksumBase64(encrypted) == "" {
		t.Fatal("encrypted object checksum mismatch")
	}

	tampered := append([]byte(nil), encrypted...)
	tampered[len(tampered)-3] ^= 1
	if _, err := Decrypt(key, tampered); !errors.Is(err, ErrInvalidEncryptedData) {
		t.Fatalf("tampered ciphertext error = %v", err)
	}
	wrongKey := append([]byte(nil), key...)
	wrongKey[0] ^= 1
	if _, err := Decrypt(wrongKey, encrypted); !errors.Is(err, ErrInvalidEncryptedData) {
		t.Fatalf("wrong key error = %v", err)
	}
}

func TestEncryptedObjectRejectsUnknownEnvelopeFields(t *testing.T) {
	key := bytes.Repeat([]byte{0x24}, 32)
	encrypted, err := encryptWithRandom(key, fixtureBundle(), bytes.NewReader(bytes.Repeat([]byte{0x42}, 64)))
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	unknown := append(append([]byte(nil), encrypted[:len(encrypted)-1]...), []byte(`,"unknown":true}`)...)
	if _, err := Decrypt(key, unknown); !errors.Is(err, ErrInvalidEncryptedData) {
		t.Fatalf("unknown encrypted field error = %v", err)
	}
}

func TestCanonicalPacketOrderSurvivesRTPSequenceAndTimestampWrap(t *testing.T) {
	bundle := fixtureBundle()
	bundle.Fragments = []RTPFragment{{
		Track: testTrack("track-a", 1, "0"),
		Packets: []RTPPacket{
			{SequenceNumber: 0, ExtendedSequenceNumber: 65_536, Timestamp: 10, SSRC: 1, PayloadType: 111, Payload: []byte{2}},
			{SequenceNumber: 65_535, ExtendedSequenceNumber: 65_535, Timestamp: ^uint32(0) - 10, SSRC: 1, PayloadType: 111, Payload: []byte{1}},
		},
	}}
	encoded, err := Encode(bundle)
	if err != nil {
		t.Fatalf("encode wrapped RTP: %v", err)
	}
	decoded, err := Decode(encoded)
	if err != nil {
		t.Fatalf("decode wrapped RTP: %v", err)
	}
	packets := decoded.Fragments[0].Packets
	if packets[0].ExtendedSequenceNumber != 65_535 || packets[1].ExtendedSequenceNumber != 65_536 {
		t.Fatalf("wrapped packet order = %+v", packets)
	}

	bundle.Fragments[0].Packets[0].ExtendedSequenceNumber++
	if _, err := Encode(bundle); err == nil {
		t.Fatal("mismatched extended sequence was accepted")
	}
}

func TestClearSealedBundleClearsPlaintextBuffers(t *testing.T) {
	assembler, err := NewAssembler(testConfig(1))
	if err != nil {
		t.Fatalf("new assembler: %v", err)
	}
	if err := assembler.AddPacket(testPacket(testTrack("track-a", 1, "0"), 0, 0, 1, 1, 2, 3)); err != nil {
		t.Fatalf("add packet: %v", err)
	}
	if err := assembler.CloseNow(CloseReasonExplicit); err != nil {
		t.Fatalf("close assembler: %v", err)
	}
	sealed, err := assembler.Seal()
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	canonicalAlias := sealed.Bytes
	payloadAlias := sealed.Bundle.Fragments[0].Packets[0].Payload
	ClearSealedBundle(&sealed)
	if sealed.Bytes != nil || sealed.Bundle.Fragments != nil || sealed.ContentBytes != 0 || sealed.PacketCount != 0 {
		t.Fatalf("sealed bundle retained plaintext state: %+v", sealed)
	}
	if !bytes.Equal(canonicalAlias, make([]byte, len(canonicalAlias))) || !bytes.Equal(payloadAlias, make([]byte, len(payloadAlias))) {
		t.Fatal("plaintext aliases were not cleared")
	}
}

func ExampleAssembler() {
	assembler, _ := NewAssembler(testConfig(1))
	track := testTrack("track-a", 1, "0")
	_ = assembler.AddPacket(testPacket(track, 0, 0, 1, 1, 2, 3))
	_ = assembler.Stop(1_000, 1_000)
	sealed, _ := assembler.Seal()
	fmt.Println(sealed.Bundle.Manifest.CloseReason, sealed.PacketCount)
	// Output: final_stop 1
}
