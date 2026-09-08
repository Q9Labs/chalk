package recordingdecode

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

func TestAppendFragmentRunCollapsesExactDuplicatesWithinFragment(t *testing.T) {
	t.Parallel()

	state := testSpoolState(t)
	duplicate := testSpoolPacket(10, 100, []byte("duplicate"))
	fragment := recordingbundle.RTPFragment{Packets: []recordingbundle.RTPPacket{
		duplicate,
		duplicate,
		testSpoolPacket(11, 101, []byte("next")),
	}}
	if err := appendFragmentRun(context.Background(), state, fragment, 0); err != nil {
		t.Fatalf("appendFragmentRun() error = %v", err)
	}
	if err := finalizeSourceSpool(context.Background(), state); err != nil {
		t.Fatalf("finalizeSourceSpool() error = %v", err)
	}

	packets := readTestSpool(t, state.spoolPath)
	assertTestSpoolPackets(t, packets, []uint64{10, 11}, [][]byte{[]byte("duplicate"), []byte("next")})
}

func TestFinalizeSourceSpoolMergesLateAndRepeatedPacketsWithoutChangingMedia(t *testing.T) {
	t.Parallel()

	state := testSpoolState(t)
	fragments := []recordingbundle.RTPFragment{
		{Packets: []recordingbundle.RTPPacket{
			testSpoolPacket(65_534, 1_000, []byte("first")),
			testSpoolPacket(65_536, 1_020, []byte("third")),
		}},
		{Packets: []recordingbundle.RTPPacket{
			testSpoolPacket(65_535, 1_010, []byte("late-second")),
			testSpoolPacket(65_536, 1_020, []byte("third")),
			testSpoolPacket(65_537, 1_030, []byte("fourth")),
		}},
	}
	for _, fragment := range fragments {
		if err := appendFragmentRun(context.Background(), state, fragment, 0); err != nil {
			t.Fatalf("appendFragmentRun() error = %v", err)
		}
	}
	if err := finalizeSourceSpool(context.Background(), state); err != nil {
		t.Fatalf("finalizeSourceSpool() error = %v", err)
	}

	packets := readTestSpool(t, state.spoolPath)
	assertTestSpoolPackets(t, packets,
		[]uint64{65_534, 65_535, 65_536, 65_537},
		[][]byte{[]byte("first"), []byte("late-second"), []byte("third"), []byte("fourth")},
	)
	if got := []uint32{packets[0].Timestamp, packets[1].Timestamp, packets[2].Timestamp, packets[3].Timestamp}; !equalUint32s(got, []uint32{1_000, 1_010, 1_020, 1_030}) {
		t.Fatalf("timestamps = %v", got)
	}
}

func TestFinalizeSourceSpoolRejectsMultipassConflictAndCleansUp(t *testing.T) {
	t.Parallel()

	state := testSpoolState(t)
	if err := appendFragmentRun(context.Background(), state, recordingbundle.RTPFragment{Packets: []recordingbundle.RTPPacket{
		testSpoolPacket(42, 100, []byte("original")),
	}}, 0); err != nil {
		t.Fatal(err)
	}
	for sequence := uint64(100); sequence < 100+spoolMergeFanIn-1; sequence++ {
		if err := appendFragmentRun(context.Background(), state, recordingbundle.RTPFragment{Packets: []recordingbundle.RTPPacket{
			testSpoolPacket(sequence, uint32(sequence), []byte("filler")),
		}}, 0); err != nil {
			t.Fatal(err)
		}
	}
	if err := appendFragmentRun(context.Background(), state, recordingbundle.RTPFragment{Packets: []recordingbundle.RTPPacket{
		testSpoolPacket(42, 100, []byte("different")),
	}}, 0); err != nil {
		t.Fatal(err)
	}
	if err := finalizeSourceSpool(context.Background(), state); !errors.Is(err, ErrInvalidBundle) {
		t.Fatalf("finalizeSourceSpool() error = %v, want ErrInvalidBundle", err)
	}
	if _, err := os.Stat(state.spoolPath + ".merge"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("incomplete merge output remains: %v", err)
	}
	if _, err := os.Stat(state.spoolPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("incomplete final spool remains: %v", err)
	}
}

func TestStoredRTPPacketIdentityIncludesEveryRetainedField(t *testing.T) {
	t.Parallel()

	original := testSpoolPacket(42, 100, []byte("payload"))
	if !sameStoredRTPPacket(original, original) {
		t.Fatal("sameStoredRTPPacket() rejected identical packet")
	}
	tests := []struct {
		name   string
		mutate func(*recordingbundle.RTPPacket)
	}{
		{name: "wire sequence", mutate: func(packet *recordingbundle.RTPPacket) { packet.SequenceNumber++ }},
		{name: "extended sequence", mutate: func(packet *recordingbundle.RTPPacket) { packet.ExtendedSequenceNumber++ }},
		{name: "timestamp", mutate: func(packet *recordingbundle.RTPPacket) { packet.Timestamp++ }},
		{name: "SSRC", mutate: func(packet *recordingbundle.RTPPacket) { packet.SSRC++ }},
		{name: "payload type", mutate: func(packet *recordingbundle.RTPPacket) { packet.PayloadType++ }},
		{name: "marker", mutate: func(packet *recordingbundle.RTPPacket) { packet.Marker = !packet.Marker }},
		{name: "payload", mutate: func(packet *recordingbundle.RTPPacket) { packet.Payload = []byte("changed") }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := original
			test.mutate(&candidate)
			if sameStoredRTPPacket(original, candidate) {
				t.Fatal("sameStoredRTPPacket() accepted changed retained field")
			}
		})
	}
}

func TestAppendFragmentRunRejectsWireSequenceMismatchBeforeSpooling(t *testing.T) {
	t.Parallel()

	state := testSpoolState(t)
	packet := testSpoolPacket(42, 100, []byte("payload"))
	packet.SequenceNumber++
	err := appendFragmentRun(context.Background(), state, recordingbundle.RTPFragment{Packets: []recordingbundle.RTPPacket{packet}}, 0)
	if !errors.Is(err, ErrInvalidBundle) {
		t.Fatalf("appendFragmentRun() error = %v, want ErrInvalidBundle", err)
	}
	if _, statErr := os.Stat(state.spoolPath); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("invalid packet created a spool: %v", statErr)
	}
}

func TestFinalizeSourceSpoolBoundsFanInAndResetsAtRecoveryGeneration(t *testing.T) {
	t.Parallel()

	state := testSpoolState(t)
	for index := 0; index < spoolMergeFanIn+1; index++ {
		sequence := uint64(1_000 + spoolMergeFanIn - index)
		if err := appendFragmentRun(context.Background(), state, recordingbundle.RTPFragment{Packets: []recordingbundle.RTPPacket{
			testSpoolPacket(sequence, uint32(sequence), []byte{byte(index)}),
		}}, 0); err != nil {
			t.Fatal(err)
		}
	}
	for _, sequence := range []uint64{2, 1} {
		if err := appendFragmentRun(context.Background(), state, recordingbundle.RTPFragment{Packets: []recordingbundle.RTPPacket{
			testSpoolPacket(sequence, uint32(sequence), []byte{byte(sequence)}),
		}}, 1); err != nil {
			t.Fatal(err)
		}
	}
	if err := finalizeSourceSpool(context.Background(), state); err != nil {
		t.Fatalf("finalizeSourceSpool() error = %v", err)
	}

	packets := readTestSpool(t, state.spoolPath)
	if len(packets) != spoolMergeFanIn+3 {
		t.Fatalf("packet count = %d, want %d", len(packets), spoolMergeFanIn+3)
	}
	for index := 0; index < spoolMergeFanIn+1; index++ {
		if want := uint64(1_000 + index); packets[index].ExtendedSequenceNumber != want {
			t.Fatalf("generation zero packet %d sequence = %d, want %d", index, packets[index].ExtendedSequenceNumber, want)
		}
	}
	if got := []uint64{packets[len(packets)-2].ExtendedSequenceNumber, packets[len(packets)-1].ExtendedSequenceNumber}; got[0] != 1 || got[1] != 2 {
		t.Fatalf("recovery generation sequences = %v, want [1 2]", got)
	}
	if len(state.spoolGroups) != 2 || len(state.spoolGroups[0].runs) != 1 || len(state.spoolGroups[1].runs) != 1 {
		t.Fatalf("final runs = %#v", state.spoolGroups)
	}
}

func TestFinalizeSourceSpoolRejectsTruncatedRun(t *testing.T) {
	t.Parallel()

	state := testSpoolState(t)
	for _, sequence := range []uint64{1, 2} {
		if err := appendFragmentRun(context.Background(), state, recordingbundle.RTPFragment{Packets: []recordingbundle.RTPPacket{
			testSpoolPacket(sequence, uint32(sequence), []byte("payload")),
		}}, 0); err != nil {
			t.Fatal(err)
		}
	}
	info, err := os.Stat(state.spoolPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(state.spoolPath, info.Size()-1); err != nil {
		t.Fatal(err)
	}
	if err := finalizeSourceSpool(context.Background(), state); !errors.Is(err, ErrDecode) {
		t.Fatalf("finalizeSourceSpool() error = %v, want ErrDecode", err)
	}
}

func TestFinalizeSourceSpoolStopsOnCancellationAndRemovesMergeOutput(t *testing.T) {
	t.Parallel()

	state := testSpoolState(t)
	for _, sequence := range []uint64{2, 1} {
		if err := appendFragmentRun(context.Background(), state, recordingbundle.RTPFragment{Packets: []recordingbundle.RTPPacket{
			testSpoolPacket(sequence, uint32(sequence), []byte("payload")),
		}}, 0); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := finalizeSourceSpool(ctx, state); !errors.Is(err, context.Canceled) {
		t.Fatalf("finalizeSourceSpool() error = %v, want context.Canceled", err)
	}
	if _, err := os.Stat(state.spoolPath + ".merge"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("cancelled merge output remains: %v", err)
	}
}

func testSpoolState(t *testing.T) *sourceState {
	t.Helper()
	return &sourceState{spoolPath: filepath.Join(t.TempDir(), "source.rtp")}
}

func equalUint32s(left, right []uint32) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
